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

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { FilesystemPolicy } from "./config.ts";

const HOME_DIRECTORY = homedir();

/** Expand a leading `~` and resolve relative paths against `cwd` to an absolute path. */
export function expandPath(pathValue: string, cwd: string): string {
  let expandedPath = pathValue;
  if (expandedPath === "~") {
    expandedPath = HOME_DIRECTORY;
  } else if (expandedPath.startsWith("~/")) {
    expandedPath = HOME_DIRECTORY + expandedPath.slice(1);
  }
  if (!isAbsolute(expandedPath)) {
    expandedPath = resolve(cwd, expandedPath);
  }
  return expandedPath;
}

/**
 * Resolve symlinks in an absolute path. For a path that does not exist yet,
 * resolve the nearest existing parent and append the missing part. This stops a
 * new file from being created through a symlinked directory.
 */
export function resolveRealPath(absolutePath: string): string {
  try {
    return realpathSync(absolutePath);
  } catch {
    const parentDirectory = dirname(absolutePath);
    if (parentDirectory === absolutePath) {
      return absolutePath;
    }
    return resolve(resolveRealPath(parentDirectory), basename(absolutePath));
  }
}

function containsGlob(pathValue: string): boolean {
  return /[*?[\]]/.test(pathValue);
}

/**
 * Translate a shell-style glob to an anchored RegExp.
 * `**` crosses directory separators; `*` and `?` stay within one path segment.
 */
function globToRegExp(glob: string): RegExp {
  let regexSource = "";

  for (let globIndex = 0; globIndex < glob.length; globIndex++) {
    const globCharacter = glob[globIndex];

    if (globCharacter === "*") {
      if (glob[globIndex + 1] === "*") {
        regexSource += ".*";
        globIndex++;
        // A trailing slash after `**` is optional so `**/.env` also matches
        // `.env` directly under the root.
        if (glob[globIndex + 1] === "/") {
          globIndex++;
        }
      } else {
        regexSource += "[^/]*";
      }
    } else if (globCharacter === "?") {
      regexSource += "[^/]";
    } else if ("\\^$.|+(){}".includes(globCharacter)) {
      regexSource += "\\" + globCharacter;
    } else {
      // Literal `[` and `]` are left as-is: they already form a valid regex
      // character class.
      regexSource += globCharacter;
    }
  }

  return new RegExp("^" + regexSource + "$");
}

/**
 * Does the absolute `targetAbsolutePath` match `pattern`?
 *  - A bare-basename glob (`*.pem`, `.env.*`, no `/`) matches the basename anywhere.
 *  - A path glob (`src/**`, `~/.config/*`) matches the full expanded path.
 *  - A literal path matches itself or any descendant (prefix/dir containment).
 */
export function matchPath(targetAbsolutePath: string, pattern: string, cwd: string): boolean {
  if (containsGlob(pattern)) {
    const matchesBasenameOnly = !pattern.includes("/") && !pattern.startsWith("~");
    if (matchesBasenameOnly) {
      return globToRegExp(pattern).test(basename(targetAbsolutePath));
    }

    // A leading `**/` followed by one name means "this basename at any depth",
    // not "under cwd". This is how the secret-file denials cover `/tmp` and
    // sibling repositories.
    const basenameAtAnyDepth = pattern.startsWith("**/") && !pattern.slice(3).includes("/");
    if (basenameAtAnyDepth) {
      return globToRegExp(pattern.slice(3)).test(basename(targetAbsolutePath));
    }

    return globToRegExp(expandPath(pattern, cwd)).test(targetAbsolutePath);
  }

  const expandedPattern = expandPath(pattern, cwd);
  if (targetAbsolutePath === expandedPattern) {
    return true;
  }

  // Compare with a trailing separator so `/x/proj` cannot match `/x/proj-other`.
  const directoryPrefix = expandedPattern.endsWith("/") ? expandedPattern : expandedPattern + "/";
  return targetAbsolutePath.startsWith(directoryPrefix);
}

export function matchesAny(targetAbsolutePath: string, patterns: string[], cwd: string): boolean {
  return patterns.some((pattern) => matchPath(targetAbsolutePath, pattern, cwd));
}

/** Read is allowed unless denied and not explicitly re-allowed. */
export function isReadAllowed(
  filesystemPolicy: FilesystemPolicy,
  targetPath: string,
  cwd: string,
): boolean {
  const resolvedTarget = resolveRealPath(expandPath(targetPath, cwd));
  const isDenied = matchesAny(resolvedTarget, filesystemPolicy.denyRead, cwd);
  const isReAllowed = matchesAny(resolvedTarget, filesystemPolicy.allowRead, cwd);
  return !isDenied || isReAllowed;
}

/** Write must be explicitly allowed, and an explicit denial wins. */
export function isWriteAllowed(
  filesystemPolicy: FilesystemPolicy,
  targetPath: string,
  cwd: string,
): boolean {
  const resolvedTarget = resolveRealPath(expandPath(targetPath, cwd));
  const isAllowed = matchesAny(resolvedTarget, filesystemPolicy.allowWrite, cwd);
  if (!isAllowed) {
    return false;
  }
  const isDenied = matchesAny(resolvedTarget, filesystemPolicy.denyWrite, cwd);
  return !isDenied;
}
