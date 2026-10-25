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
import { expandPath, matchesAny, resolveRealPath } from "./fsguard.ts";

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
 *  findArbitraryExec(); policy.test.ts checks each entry is really blocked. */
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
  "`PATH=` assignment",
];

/** Env overrides that make git/jj load config or run a program (aliases, pagers,
 *  ssh commands, editors). */
const EXEC_ENV =
  /^(GIT_CONFIG_|GIT_EXEC_PATH=|GIT_PAGER=|GIT_EDITOR=|GIT_SSH=|GIT_SSH_COMMAND=|GIT_ASKPASS=|GIT_EXTERNAL_DIFF=|GIT_PROXY_COMMAND=|GIT_SEQUENCE_EDITOR=|GIT_TEMPLATE_DIR=|JJ_CONFIG=)/;

/** Leading tokens that wrap the real program; skipped when finding argv[0]. */
const WRAPPERS = new Set(["sudo", "doas", "command", "env", "nice", "nohup", "time", "stdbuf"]);

/** Wrapper flags that consume the following token as their value. Without this,
 *  `sudo -u git ssh host` would treat the user `git` as the program. */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set([
    "-u",
    "--user",
    "-g",
    "--group",
    "-p",
    "--prompt",
    "-C",
    "--close-from",
    "-r",
    "--role",
    "-t",
    "--type",
    "-U",
    "--other-user",
    "-R",
    "--chroot",
    "-D",
    "--chdir",
    "-T",
    "--command-timeout",
    "-h",
    "--host",
  ]),
  doas: new Set(["-u", "-C"]),
  env: new Set([
    "-u",
    "--unset",
    "-C",
    "--chdir",
    "--block-signal",
    "--default-signal",
    "--ignore-signal",
  ]),
  nice: new Set(["-n", "--adjustment"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
};

export type Action = "block" | "bypass" | "sandbox";

export interface Decision {
  action: Action;
  reason?: string;
}

/** Split a command line into whitespace-separated tokens, honoring simple
 *  single/double quoting (no shell expansion). */
export function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  let currentToken = "";
  let activeQuote: string | null = null;
  let hasToken = false;

  for (let characterIndex = 0; characterIndex < commandLine.length; characterIndex++) {
    const character = commandLine[characterIndex];

    if (activeQuote) {
      if (character === activeQuote) {
        activeQuote = null;
      } else {
        currentToken += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      activeQuote = character;
      hasToken = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (currentToken || hasToken) {
        tokens.push(currentToken);
        currentToken = "";
        hasToken = false;
      }
      continue;
    }

    currentToken += character;
    hasToken = true;
  }

  if (currentToken || hasToken) {
    tokens.push(currentToken);
  }
  return tokens;
}

function stripDirectory(pathValue: string): string {
  const lastSlashIndex = pathValue.lastIndexOf("/");
  return lastSlashIndex >= 0 ? pathValue.slice(lastSlashIndex + 1) : pathValue;
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * Index of the real program in a segment's tokens, skipping `VAR=value`
 * assignments, leading wrappers, wrapper flags, and wrapper flag values.
 * Equals `tokens.length` when there is no program.
 */
function programIndex(tokens: string[]): number {
  let tokenIndex = 0;
  let currentWrapper: string | null = null;

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];

    // `FOO=bar git ...` assigns an environment variable, not the program.
    if (isEnvironmentAssignment(token)) {
      tokenIndex++;
      continue;
    }

    const wrapperName = stripDirectory(token);
    if (WRAPPERS.has(wrapperName)) {
      currentWrapper = wrapperName;
      tokenIndex++;
      continue;
    }

    if (token.startsWith("-")) {
      tokenIndex++;
      const flagName = token.split("=")[0];
      const flagTakesValue =
        currentWrapper !== null && WRAPPER_VALUE_FLAGS[currentWrapper]?.has(flagName);
      // `--user=git` already contains its value; `--user git` needs the next
      // token skipped too.
      if (flagTakesValue && !token.includes("=") && tokenIndex < tokens.length) {
        tokenIndex++;
      }
      continue;
    }

    break;
  }

  return tokenIndex;
}

/** Split on pipeline/sequence operators, but not on redirection ampersands
 *  (`2>&1`, `&>file`) which stay inside one segment. */
function splitCommandSegments(commandLine: string): string[] {
  return commandLine
    .split(/\|\||&&|[;\n|]|(?<!>)&(?!>)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Walk every segment and collect its program name. A non-null escape form means
 * a trusted tool was invoked in a way that could run another program.
 */
function scanCommand(commandLine: string): { programs: string[]; escapeForm: string | null } {
  const programs: string[] = [];
  let escapeForm: string | null = null;

  for (const segment of splitCommandSegments(commandLine)) {
    const tokens = tokenize(segment);
    const programTokenIndex = programIndex(tokens);

    if (programTokenIndex < tokens.length) {
      programs.push(stripDirectory(tokens[programTokenIndex]));
    }
    escapeForm ??= findArbitraryExec(tokens);
  }

  return { programs, escapeForm };
}

/** Return the primary program (argv[0], stripped of path and wrappers) of every
 *  pipeline/sequence segment in the command line. */
export function extractPrograms(commandLine: string): string[] {
  return scanCommand(commandLine).programs;
}

function isJjConfigEscapeFlag(argument: string): boolean {
  return (
    argument === "--config" ||
    argument.startsWith("--config=") ||
    argument === "--config-file" ||
    argument.startsWith("--config-file=") ||
    argument === "--config-toml" ||
    argument.startsWith("--config-toml=")
  );
}

function isGitConfigEscapeFlag(argument: string): boolean {
  return (
    argument === "-c" ||
    argument === "--config-env" ||
    argument.startsWith("--config-env=") ||
    argument === "--exec-path" ||
    argument.startsWith("--exec-path=") ||
    argument === "--upload-pack" ||
    argument.startsWith("--upload-pack=") ||
    argument === "--receive-pack" ||
    argument.startsWith("--receive-pack=")
  );
}

/** Short form of `--upload-pack`: `git clone -u <program>` runs it locally. */
function isShortUploadPackFlag(argument: string): boolean {
  return argument === "-u" || (argument.startsWith("-u") && !argument.startsWith("--"));
}

/** Why this segment uses an escape form of a trusted tool, or null.
 *
 *  shortcut: this is a denylist of the direct escape forms (jj util exec, git
 *  command-config flags, config env vars). A repo or config file can still
 *  define an executable alias/hook, and a cloned repo's `.git/config` is
 *  trusted once `git` is trusted. Upgrade by running trusted tools with a
 *  scrubbed config/env if that stops being acceptable. */
function findArbitraryExec(tokens: string[]): string | null {
  const programTokenIndex = programIndex(tokens);
  if (programTokenIndex >= tokens.length) {
    return null;
  }

  const program = stripDirectory(tokens[programTokenIndex]);
  const programArguments = tokens.slice(programTokenIndex + 1);
  const prefixTokens = tokens.slice(0, programTokenIndex);

  // A PATH override resolves a trusted name from a writable directory.
  if (prefixTokens.some((token) => token.startsWith("PATH="))) {
    return "`PATH=` assignment";
  }

  if (program === "git" || program === "jj") {
    const execEnvironment = prefixTokens.find((token) => EXEC_ENV.test(token));
    if (execEnvironment) {
      return `\`${execEnvironment.split("=")[0]}\``;
    }
  }

  if (program === "jj") {
    const utilIndex = programArguments.indexOf("util");
    if (utilIndex >= 0) {
      const nextArgument = programArguments[utilIndex + 1];
      if (nextArgument === "exec" || nextArgument === "run") {
        return "`jj util exec`";
      }
      if (
        nextArgument === "--" &&
        (programArguments[utilIndex + 2] === "exec" || programArguments[utilIndex + 2] === "run")
      ) {
        return "`jj util exec`";
      }
    }

    // --config/--config-file/--config-toml can define an alias to any command.
    const configFlag = programArguments.find(isJjConfigEscapeFlag);
    if (configFlag) {
      return `\`jj ${configFlag.split("=")[0]}\``;
    }
  }

  if (program === "git") {
    const configFlag = programArguments.find(isGitConfigEscapeFlag);
    if (configFlag) {
      return `\`git ${configFlag.split("=")[0]}\``;
    }

    if (programArguments.includes("clone") && programArguments.some(isShortUploadPackFlag)) {
      return "`git clone -u`";
    }
  }

  return null;
}

/** Shell constructs whose contents are not visible to the static token scan. */
function hasShellExpansion(commandLine: string): boolean {
  return /\$\(|`|<\(|>\(/.test(commandLine);
}

function isUrlLike(token: string): boolean {
  return token.includes("://") || /^[a-zA-Z]+@[^/]+:/.test(token); // scheme:// or user@host:
}

/**
 * Static scan of command tokens for sandbox-protected paths. Applied before a
 * trusted-tool bypass so a bypassed `git`/`gh` cannot be used to reach denied
 * files. Best-effort: flags any token that resolves under a denyRead (and not
 * re-allowed by allowRead) or matches a denyWrite pattern.
 */
/** Values a token carries that might be a path. A bare flag's value is a
 *  separate token and is scanned on its own. */
function pathValuesInToken(rawToken: string): string[] {
  if (!rawToken.startsWith("-")) {
    return [rawToken];
  }

  const equalsIndex = rawToken.indexOf("=");
  if (equalsIndex >= 0) {
    // Long or short option with an attached value, e.g. `--file=~/.ssh/id_rsa`.
    return [rawToken.slice(equalsIndex + 1)];
  }

  // Short option with an attached path, e.g. `-F~/.ssh/id_rsa` or `-F./key`.
  const attachedShortValue = /^-[A-Za-z]+([~/.].*)$/.exec(rawToken);
  return attachedShortValue ? [attachedShortValue[1]] : [];
}

export function deniedTokens(commandLine: string, config: SandboxConfig, cwd: string): string[] {
  const filesystemPolicy = config.filesystem;
  const deniedTokensFound: string[] = [];

  for (const rawToken of tokenize(commandLine)) {
    for (const tokenValue of pathValuesInToken(rawToken)) {
      if (!tokenValue || isUrlLike(tokenValue)) {
        continue;
      }

      const absolutePath = resolveRealPath(expandPath(tokenValue, cwd));
      const readDenied =
        matchesAny(absolutePath, filesystemPolicy.denyRead, cwd) &&
        !matchesAny(absolutePath, filesystemPolicy.allowRead, cwd);
      const writeDenied = matchesAny(absolutePath, filesystemPolicy.denyWrite, cwd);

      if (readDenied || writeDenied) {
        deniedTokensFound.push(tokenValue);
      }
    }
  }

  return deniedTokensFound;
}

export function classifyCommand(commandLine: string, config: SandboxConfig, cwd: string): Decision {
  const { programs, escapeForm } = scanCommand(commandLine);

  for (const program of programs) {
    if (SSH_BLOCKLIST.includes(program)) {
      return {
        action: "block",
        reason: `direct \`${program}\` is blocked by sandbox policy (SSH/file-transfer tools are not permitted). Use \`git\`/\`gh\` for repository access.`,
      };
    }
  }

  if (escapeForm) {
    return {
      action: "block",
      reason: `blocked by sandbox policy: ${escapeForm} can make a trusted tool run an arbitrary command. Invoke the command directly (it will be sandboxed).`,
    };
  }

  if (programs.length > 0 && programs.every((program) => TRUSTED_TOOLS.has(program))) {
    // The static scan cannot see inside substitutions. A bypass would hand the
    // hidden command full host access, so run the whole line under srt instead.
    if (hasShellExpansion(commandLine)) {
      return { action: "sandbox" };
    }

    const deniedPaths = deniedTokens(commandLine, config, cwd);
    if (deniedPaths.length > 0) {
      return {
        action: "block",
        reason: `trusted-tool bypass denied: command references sandbox-protected path(s): ${deniedPaths.join(", ")}`,
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
