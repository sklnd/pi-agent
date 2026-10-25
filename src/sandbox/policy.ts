/**
 * Command policy: classify a bash command line into block / bypass / sandbox.
 *
 * Fixed, non-configurable rules (per the sandbox spec):
 *   - Direct ssh/scp/sftp/rsync are BLOCKED.
 *   - git/gh (and the configured trusted tools) may BYPASS the OS sandbox —
 *     but only after a static denyRead/denyWrite token scan passes.
 *   - Everything else runs SANDBOXED under srt.
 *
 * Command parsing here is best-effort (a shell is not a static grammar); it is
 * a policy gate layered on top of the OS sandbox, not a substitute for it. To
 * be conservative, a bypass is granted only when EVERY pipeline/sequence
 * segment invokes a trusted tool — mixing a trusted tool with any other program
 * falls back to running the whole line sandboxed.
 *
 * No pi imports — unit-testable with plain `node`.
 */

import type { SandboxConfig } from "./config.ts";
import { expandPath, matchesAny } from "./fsguard.ts";

/** Direct network file-transfer / shell tools that are never permitted. */
export const SSH_BLOCKLIST = ["ssh", "scp", "sftp", "rsync"];

/** Tools trusted to bypass the OS sandbox (get full fs + network). */
export const TRUSTED_TOOLS = new Set([
  "git",
  "gh",
  "jj",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "cargo",
  "mise",
  "docker",
  "kubectl",
]);

/** Forms that let a trusted tool run an arbitrary program. Blocked outright so
 *  a bypass cannot be turned into a shell escape. Keep in sync with
 *  arbitraryExec(); policy.test.ts checks each entry is really blocked. */
export const ARBITRARY_EXEC_FORMS = [
  "`jj util exec`",
  "`jj --config`",
  "`jj --config-file`",
  "`git -c`",
  "`git --config-env`",
  "`git --exec-path`",
  "`git --upload-pack`",
  "`git clone -u`",
  "`git --receive-pack`",
  "`GIT_*`/`JJ_*` config env",
];

/** Env overrides that make git/jj load config or run a program (aliases, pagers,
 *  ssh commands, editors). */
const EXEC_ENV =
  /^(GIT_CONFIG_|GIT_EXEC_PATH=|GIT_PAGER=|GIT_EDITOR=|GIT_SSH=|GIT_SSH_COMMAND=|GIT_ASKPASS=|GIT_EXTERNAL_DIFF=|GIT_PROXY_COMMAND=|GIT_SEQUENCE_EDITOR=|GIT_TEMPLATE_DIR=|JJ_CONFIG=)/;

/** Leading tokens that wrap the real program; skipped when finding argv[0]. */
const WRAPPERS = new Set(["sudo", "doas", "command", "env", "nice", "nohup", "time", "stdbuf"]);

export type Action = "block" | "bypass" | "sandbox";

export interface Decision {
  action: Action;
  reason?: string;
}

/** Split a command line into whitespace-separated tokens, honoring simple
 *  single/double quoting (no shell expansion). */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let had = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      had = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur || had) {
        out.push(cur);
        cur = "";
        had = false;
      }
      continue;
    }
    cur += c;
    had = true;
  }
  if (cur || had) out.push(cur);
  return out;
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Index of the real program in a segment's tokens, skipping VAR=value, leading
 *  wrappers, and wrapper flags. Equals tokens.length when there is no program. */
function programIndex(tokens: string[]): number {
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      idx++; // VAR=value prefix
      continue;
    }
    if (WRAPPERS.has(baseName(tok))) {
      idx++; // sudo/env/... wrapper
      continue;
    }
    if (tok.startsWith("-")) {
      idx++; // wrapper flag (e.g. `sudo -E`); a program name is never a flag
      continue;
    }
    break;
  }
  return idx;
}

function segments(command: string): string[] {
  return command
    .split(/\|\||&&|[;\n|&]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scan(command: string): { progs: string[]; escape: string | null } {
  const progs: string[] = [];
  let escape: string | null = null;
  for (const seg of segments(command)) {
    const tokens = tokenize(seg);
    const idx = programIndex(tokens);
    if (idx < tokens.length) progs.push(baseName(tokens[idx]));
    escape ??= arbitraryExec(tokens);
  }
  return { progs, escape };
}

/** Return the primary program (argv[0], stripped of path and wrappers) of every
 *  pipeline/sequence segment in the command line. */
export function extractPrograms(command: string): string[] {
  return scan(command).progs;
}

/** Why this segment uses an escape form of a trusted tool, or null.
 *
 *  shortcut: this is a denylist of the direct escape forms (jj util exec, git
 *  command-config flags, config env vars). A repo or config file can still
 *  define an executable alias/hook, and a cloned repo's `.git/config` is
 *  trusted once `git` is trusted. Upgrade by running trusted tools with a
 *  scrubbed config/env if that stops being acceptable. */
function arbitraryExec(tokens: string[]): string | null {
  const idx = programIndex(tokens);
  if (idx >= tokens.length) return null;
  const program = baseName(tokens[idx]);
  const args = tokens.slice(idx + 1);

  if (program === "git" || program === "jj") {
    const env = tokens.slice(0, idx).find((t) => EXEC_ENV.test(t));
    if (env) return `\`${env.split("=")[0]}\``;
  }
  if (program === "jj") {
    const u = args.indexOf("util");
    if (u >= 0) {
      const next = args[u + 1];
      if (next === "exec" || next === "run") return "`jj util exec`";
      if (next === "--" && (args[u + 2] === "exec" || args[u + 2] === "run")) {
        return "`jj util exec`";
      }
    }
    // --config/--config-file/--config-toml can define an alias to any command.
    const flag = args.find(
      (a) =>
        a === "--config" ||
        a.startsWith("--config=") ||
        a === "--config-file" ||
        a.startsWith("--config-file=") ||
        a === "--config-toml" ||
        a.startsWith("--config-toml="),
    );
    if (flag) return `\`jj ${flag.split("=")[0]}\``;
  }
  if (program === "git") {
    const flag = args.find(
      (a) =>
        a === "-c" ||
        a === "--config-env" ||
        a.startsWith("--config-env=") ||
        a === "--exec-path" ||
        a.startsWith("--exec-path=") ||
        a === "--upload-pack" ||
        a.startsWith("--upload-pack=") ||
        a === "--receive-pack" ||
        a.startsWith("--receive-pack="),
    );
    if (flag) return `\`git ${flag.split("=")[0]}\``;
    // Short form of --upload-pack: `git clone -u <program>` runs it locally.
    if (
      args.includes("clone") &&
      args.some((a) => a === "-u" || (a.startsWith("-u") && !a.startsWith("--")))
    ) {
      return "`git clone -u`";
    }
  }
  return null;
}

function looksLikeUrl(tok: string): boolean {
  return tok.includes("://") || /^[a-zA-Z]+@[^/]+:/.test(tok); // scheme:// or user@host:
}

/**
 * Static scan of command tokens for sandbox-protected paths. Applied before a
 * trusted-tool bypass so a bypassed `git`/`gh` cannot be used to reach denied
 * files. Best-effort: flags any token that resolves under a denyRead (and not
 * re-allowed by allowRead) or matches a denyWrite pattern.
 */
export function deniedTokens(command: string, config: SandboxConfig, cwd: string): string[] {
  const fs = config.filesystem;
  const hits: string[] = [];
  for (const tok of tokenize(command)) {
    if (!tok || tok.startsWith("-") || looksLikeUrl(tok)) continue;
    const t = expandPath(tok, cwd);
    const readDenied = matchesAny(t, fs.denyRead, cwd) && !matchesAny(t, fs.allowRead, cwd);
    const writeDenied = matchesAny(t, fs.denyWrite, cwd);
    if (readDenied || writeDenied) hits.push(tok);
  }
  return hits;
}

export function classifyCommand(command: string, config: SandboxConfig, cwd: string): Decision {
  const { progs, escape } = scan(command);

  for (const p of progs) {
    if (SSH_BLOCKLIST.includes(p)) {
      return {
        action: "block",
        reason: `direct \`${p}\` is blocked by sandbox policy (SSH/file-transfer tools are not permitted). Use \`git\`/\`gh\` for repository access.`,
      };
    }
  }

  if (escape) {
    return {
      action: "block",
      reason: `blocked by sandbox policy: ${escape} can make a trusted tool run an arbitrary command. Invoke the command directly (it will be sandboxed).`,
    };
  }

  if (progs.length > 0 && progs.every((p) => TRUSTED_TOOLS.has(p))) {
    const bad = deniedTokens(command, config, cwd);
    if (bad.length > 0) {
      return {
        action: "block",
        reason: `trusted-tool bypass denied: command references sandbox-protected path(s): ${bad.join(", ")}`,
      };
    }
    return { action: "bypass" };
  }

  return { action: "sandbox" };
}

/** Lines describing the fixed command policy, derived from the live rules so
 *  `/sandbox` cannot drift from what is enforced. */
export function describeCommandPolicy(): string[] {
  return [
    `blocked: ${SSH_BLOCKLIST.join(", ")}; ${ARBITRARY_EXEC_FORMS.join(", ")}`,
    `bypass:  ${[...TRUSTED_TOOLS].join(", ")} (after a path scan)`,
  ];
}
