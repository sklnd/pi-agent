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

import type { SandboxConfig } from "./config.ts"
import { expandPath, matchesAny } from "./fsguard.ts"

/** Direct network file-transfer / shell tools that are never permitted. */
export const SSH_BLOCKLIST = ["ssh", "scp", "sftp", "rsync"]

/** Tools trusted to bypass the OS sandbox (get full fs + network).
 *  `nix` and any `nix-*` binary are matched separately by prefix. */
export const TRUSTED_TOOLS = new Set([
  "git",
  "gh",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "cargo",
  "mise",
  "docker",
  "kubectl",
])

/** Leading tokens that wrap the real program; skipped when finding argv[0]. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "command",
  "env",
  "nice",
  "nohup",
  "time",
  "stdbuf",
])

export type Action = "block" | "bypass" | "sandbox"

export interface Decision {
  action: Action
  reason?: string
}

/** Split a command line into whitespace-separated tokens, honoring simple
 *  single/double quoting (no shell expansion). */
export function tokenize(s: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | null = null
  let had = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      had = true
      continue
    }
    if (/\s/.test(c)) {
      if (cur || had) {
        out.push(cur)
        cur = ""
        had = false
      }
      continue
    }
    cur += c
    had = true
  }
  if (cur || had) out.push(cur)
  return out
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

export function isTrusted(program: string): boolean {
  return (
    TRUSTED_TOOLS.has(program) ||
    program === "nix" ||
    program.startsWith("nix-")
  )
}

/** Return the primary program (argv[0], stripped of path and wrappers) of every
 *  pipeline/sequence segment in the command line. */
export function extractPrograms(command: string): string[] {
  const segments = command
    .split(/\|\||&&|[;\n|&]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const progs: string[] = []
  for (const seg of segments) {
    const tokens = tokenize(seg)
    let idx = 0
    while (idx < tokens.length) {
      const tok = tokens[idx]
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
        idx++ // VAR=value prefix
        continue
      }
      if (WRAPPERS.has(baseName(tok))) {
        idx++ // sudo/env/... wrapper
        continue
      }
      if (tok.startsWith("-")) {
        idx++ // wrapper flag (e.g. `sudo -E`); a program name is never a flag
        continue
      }
      break
    }
    if (idx < tokens.length) progs.push(baseName(tokens[idx]))
  }
  return progs
}

function looksLikeUrl(tok: string): boolean {
  return tok.includes("://") || /^[a-zA-Z]+@[^/]+:/.test(tok) // scheme:// or user@host:
}

/**
 * Static scan of command tokens for sandbox-protected paths. Applied before a
 * trusted-tool bypass so a bypassed `git`/`gh` cannot be used to reach denied
 * files. Best-effort: flags any token that resolves under a denyRead (and not
 * re-allowed by allowRead) or matches a denyWrite pattern.
 */
export function deniedTokens(
  command: string,
  config: SandboxConfig,
  cwd: string,
): string[] {
  const fs = config.filesystem
  const hits: string[] = []
  for (const tok of tokenize(command)) {
    if (!tok || tok.startsWith("-") || looksLikeUrl(tok)) continue
    const t = expandPath(tok, cwd)
    const readDenied =
      matchesAny(t, fs.denyRead, cwd) && !matchesAny(t, fs.allowRead, cwd)
    const writeDenied = matchesAny(t, fs.denyWrite, cwd)
    if (readDenied || writeDenied) hits.push(tok)
  }
  return hits
}

export function classifyCommand(
  command: string,
  config: SandboxConfig,
  cwd: string,
): Decision {
  const progs = extractPrograms(command)

  for (const p of progs) {
    if (SSH_BLOCKLIST.includes(p)) {
      return {
        action: "block",
        reason: `direct \`${p}\` is blocked by sandbox policy (SSH/file-transfer tools are not permitted). Use \`git\`/\`gh\` for repository access.`,
      }
    }
  }

  if (progs.length > 0 && progs.every(isTrusted)) {
    const bad = deniedTokens(command, config, cwd)
    if (bad.length > 0) {
      return {
        action: "block",
        reason: `trusted-tool bypass denied: command references sandbox-protected path(s): ${bad.join(", ")}`,
      }
    }
    return { action: "bypass" }
  }

  return { action: "sandbox" }
}
