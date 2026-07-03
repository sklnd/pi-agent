/**
 * srt (Anthropic sandbox-runtime) integration: translate a SandboxConfig into
 * an srt settings file, and provide a pi BashOperations backend that routes
 * each command through the command policy — blocking, bypassing, or running it
 * under `srt --settings <file> -c '<command>'`.
 *
 * srt takes ALL policy via its JSON settings file (there are no policy CLI
 * flags); `-c` passes the command string verbatim (srt wraps it in the user's
 * shell inside the sandbox), and srt streams stdio and forwards the child's
 * exit code.
 *
 * The only pi import is a TYPE (`BashOperations`), which node strips — so this
 * module is unit-testable with plain `node` too.
 */

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BashOperations } from "@earendil-works/pi-coding-agent"
import type { SandboxConfig } from "./config.ts"
import { classifyCommand } from "./policy.ts"

/** Absolute path to the srt binary. nix pins this via env var; falls back to PATH. */
const SRT_BIN = process.env.PI_SANDBOX_SRT_BIN || "srt"

/** Project the extension's config onto srt's settings schema (drop `enabled`). */
export function toSrtSettings(config: SandboxConfig): Record<string, unknown> {
  return {
    network: {
      allowedDomains: config.network.allowedDomains,
      deniedDomains: config.network.deniedDomains,
    },
    filesystem: {
      denyRead: config.filesystem.denyRead,
      allowRead: config.filesystem.allowRead,
      allowWrite: config.filesystem.allowWrite,
      denyWrite: config.filesystem.denyWrite,
    },
  }
}

export interface SrtSettingsFile {
  path: string
  cleanup: () => void
}

/** Write srt settings to a private temp file. Returns the path and a cleanup fn. */
export function writeSrtSettings(config: SandboxConfig): SrtSettingsFile {
  const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-"))
  const path = join(dir, "srt-settings.json")
  writeFileSync(path, JSON.stringify(toSrtSettings(config), null, 2), {
    mode: 0o600,
  })
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

interface ExecOpts {
  onData: (data: Buffer) => void
  signal?: AbortSignal
  timeout?: number // seconds
}

/** Spawn a child in its own process group, streaming stdout+stderr to onData,
 *  honoring abort + timeout with a process-tree kill. Mirrors pi's own bash
 *  backend behavior (see examples/extensions/sandbox). */
function runChild(
  bin: string,
  args: string[],
  cwd: string,
  opts: ExecOpts,
): Promise<{ exitCode: number | null }> {
  const { onData, signal, timeout } = opts
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let timedOut = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const killTree = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
      }
    }

    if (timeout !== undefined && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        killTree()
      }, timeout * 1000)
    }

    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)

    const onAbort = () => killTree()
    signal?.addEventListener("abort", onAbort, { once: true })

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      signal?.removeEventListener("abort", onAbort)
      reject(err)
    })

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      signal?.removeEventListener("abort", onAbort)
      if (signal?.aborted) reject(new Error("aborted"))
      else if (timedOut) reject(new Error(`timeout:${timeout}`))
      else resolve({ exitCode: code })
    })
  })
}

/**
 * BashOperations backend that applies the command policy per invocation:
 *   - block   → emit the reason and return a non-zero exit (surfaced to the model)
 *   - bypass  → run directly via `bash -lc` (trusted tool, no OS sandbox)
 *   - sandbox → run under `srt --settings <file> -c <command>`
 */
export function createPolicyBashOps(
  config: SandboxConfig,
  settingsPath: string,
): BashOperations {
  return {
    async exec(command, cwd, options) {
      const decision = classifyCommand(command, config, cwd)

      if (decision.action === "block") {
        options.onData(Buffer.from(`sandbox: ${decision.reason}\n`))
        return { exitCode: 126 }
      }

      if (decision.action === "bypass") {
        return runChild("bash", ["-lc", command], cwd, options)
      }

      return runChild(
        SRT_BIN,
        ["--settings", settingsPath, "-c", command],
        cwd,
        options,
      )
    },
  }
}
