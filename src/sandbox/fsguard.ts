/**
 * Filesystem policy evaluation: expand paths, glob-match, and decide whether a
 * given path is read/write allowed under a FilesystemPolicy.
 *
 * This mirrors srt's semantics so the pi-level tool interception (defense in
 * depth) agrees with the OS sandbox:
 *   - read  is ALLOW by default; denyRead denies; allowRead re-allows (wins).
 *   - write is DENY  by default; allowWrite allows; denyWrite denies (wins).
 *
 * Unlike srt (whose globs are macOS-only), this matcher runs in-process on
 * every platform, so pi's read/write/edit/find/ls/grep tools are guarded
 * identically on Linux and macOS.
 *
 * No pi imports — unit-testable with plain `node`.
 */

import { homedir } from "node:os"
import { basename, isAbsolute, resolve } from "node:path"
import type { FilesystemPolicy } from "./config.ts"

const HOME = homedir()

/** Expand a leading `~` and resolve relative paths against `cwd` to an absolute path. */
export function expandPath(p: string, cwd: string): string {
  let s = p
  if (s === "~") s = HOME
  else if (s.startsWith("~/")) s = HOME + s.slice(1)
  if (!isAbsolute(s)) s = resolve(cwd, s)
  return s
}

function isGlob(p: string): boolean {
  return /[*?[\]]/.test(p)
}

/** Translate a shell-style glob to an anchored RegExp.
 *  `**` crosses `/`; `*` and `?` do not. */
function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"
        i++
        if (glob[i + 1] === "/") i++
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else if ("\\^$.|+(){}".includes(c)) {
      re += "\\" + c
    } else {
      re += c // includes literal [ ] which are valid regex character classes
    }
  }
  return new RegExp("^" + re + "$")
}

/**
 * Does the absolute `targetAbs` match `pattern`?
 *  - A bare-basename glob (`*.pem`, `.env.*`, no `/`) matches the basename anywhere.
 *  - A path glob (`src/**`, `~/.config/*`) matches the full expanded path.
 *  - A literal path matches itself or any descendant (prefix/dir containment).
 */
export function matchPath(
  targetAbs: string,
  pattern: string,
  cwd: string,
): boolean {
  if (isGlob(pattern)) {
    if (!pattern.includes("/") && !pattern.startsWith("~")) {
      return globToRegExp(pattern).test(basename(targetAbs))
    }
    return globToRegExp(expandPath(pattern, cwd)).test(targetAbs)
  }
  const pat = expandPath(pattern, cwd)
  if (targetAbs === pat) return true
  const prefix = pat.endsWith("/") ? pat : pat + "/"
  return targetAbs.startsWith(prefix)
}

export function matchesAny(
  targetAbs: string,
  patterns: string[],
  cwd: string,
): boolean {
  return patterns.some((p) => matchPath(targetAbs, p, cwd))
}

export function isReadAllowed(
  fs: FilesystemPolicy,
  target: string,
  cwd: string,
): boolean {
  const t = expandPath(target, cwd)
  if (matchesAny(t, fs.denyRead, cwd) && !matchesAny(t, fs.allowRead, cwd))
    return false
  return true
}

export function isWriteAllowed(
  fs: FilesystemPolicy,
  target: string,
  cwd: string,
): boolean {
  const t = expandPath(target, cwd)
  if (!matchesAny(t, fs.allowWrite, cwd)) return false
  if (matchesAny(t, fs.denyWrite, cwd)) return false
  return true
}
