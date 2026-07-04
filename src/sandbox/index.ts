/**
 * pi sandbox extension — OS-level sandboxing (Anthropic sandbox-runtime / `srt`)
 * plus pi-level filesystem enforcement.
 *
 * What it does:
 *   1. Overrides the built-in `bash` tool so every agent command runs through
 *      the command policy (block ssh/scp/sftp/rsync, bypass git/gh & trusted
 *      tools, otherwise sandbox under srt) — sandboxing happens at tool
 *      EXECUTION time.
 *   2. Intercepts `user_bash` (the `!` / `!!` interactive escapes) through the
 *      same policy so interactive shell-outs are sandboxed too.
 *   3. Intercepts the read/write/edit/find/ls/grep tools and enforces the
 *      filesystem policy at the pi level — defense in depth, because those
 *      tools run inside pi's own process and never touch the OS sandbox.
 *
 * Config (merged; project-local overrides global; both optional — falls back to
 * the baked-in DEFAULT_CONFIG):
 *   <PI_CODING_AGENT_DIR>/sandbox.json   (global,  == getAgentDir()/sandbox.json)
 *   <cwd>/.pi/sandbox.json               (project-local)
 *
 * Flags: `pi --no-sandbox` disables sandboxing for the session.
 * Command: `/sandbox` prints the active policy.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CONFIG_DIR_NAME,
  createBashTool,
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent"
import {
  coercePartial,
  DEFAULT_CONFIG,
  mergeConfig,
  type SandboxConfig,
} from "./config.ts"
import { isReadAllowed, isWriteAllowed } from "./fsguard.ts"
import { createPolicyBashOps, writeSrtSettings } from "./srt.ts"

function readJson(path: string): unknown {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch (e) {
    console.error(`[sandbox] could not parse ${path}: ${e}`)
    return {}
  }
}

function loadConfig(cwd: string): SandboxConfig {
  const globalPath = join(getAgentDir(), "sandbox.json")
  const projectPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json")
  let cfg = mergeConfig(DEFAULT_CONFIG, coercePartial(readJson(globalPath)))
  cfg = mergeConfig(cfg, coercePartial(readJson(projectPath)))
  return cfg
}

const READ_TOOLS = new Set(["read", "ls", "find", "grep"])
const WRITE_TOOLS = new Set(["write", "edit"])

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description:
      "Disable pi sandboxing (srt + filesystem policy) for this session",
    type: "boolean",
    default: false,
  })

  const localCwd = process.cwd()
  const localBash = createBashTool(localCwd)

  let state: {
    config: SandboxConfig
    settingsPath: string
    cleanup: () => void
  } | null = null

  // --- bash tool override: sandbox at execution time ---
  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (!state) return localBash.execute(id, params, signal, onUpdate)
      const tool = createBashTool(ctx?.cwd ?? localCwd, {
        operations: createPolicyBashOps(state.config, state.settingsPath),
      })
      return tool.execute(id, params, signal, onUpdate)
    },
  })

  // --- user_bash (`!` / `!!`) override: same policy ---
  pi.on("user_bash", () => {
    if (!state) return
    return { operations: createPolicyBashOps(state.config, state.settingsPath) }
  })

  // --- pi-level filesystem enforcement on the built-in file tools ---
  pi.on("tool_call", (event, ctx) => {
    if (!state) return
    const fs = state.config.filesystem
    const cwd = ctx.cwd
    const input = event.input as { path?: string }

    if (READ_TOOLS.has(event.toolName)) {
      const target = input.path ?? cwd
      if (!isReadAllowed(fs, target, cwd)) {
        return {
          block: true,
          reason: `sandbox: read access to "${target}" is denied by policy`,
        }
      }
    } else if (WRITE_TOOLS.has(event.toolName)) {
      const target = input.path
      if (target && !isWriteAllowed(fs, target, cwd)) {
        return {
          block: true,
          reason: `sandbox: write access to "${target}" is denied by policy`,
        }
      }
    }
  })

  // --- lifecycle ---
  pi.on("session_start", (_event, ctx) => {
    if (pi.getFlag("no-sandbox") === true) {
      ctx.ui.notify("pi sandbox disabled via --no-sandbox", "warning")
      return
    }

    const config = loadConfig(ctx.cwd)
    if (!config.enabled) {
      ctx.ui.notify("pi sandbox disabled via config", "info")
      return
    }

    const platform = process.platform
    if (platform !== "darwin" && platform !== "linux") {
      ctx.ui.notify(
        `pi sandbox unsupported on ${platform}; bash is NOT sandboxed`,
        "warning",
      )
      return
    }

    const { path, cleanup } = writeSrtSettings(config)
    state = { config, settingsPath: path, cleanup }

    const domains = config.network.allowedDomains.length
    const writes = config.filesystem.allowWrite.length
    ctx.ui.setStatus(
      "sandbox",
      ctx.ui.theme.fg(
        "accent",
        `🔒 srt: ${domains} domains, ${writes} write paths`,
      ),
    )
    ctx.ui.notify("pi sandbox active (srt)", "info")
  })

  pi.on("session_shutdown", () => {
    state?.cleanup()
    state = null
  })

  // --- /sandbox: show the active policy ---
  pi.registerCommand("sandbox", {
    description: "Show the active pi sandbox policy",
    handler: async (_args, ctx) => {
      const c = loadConfig(ctx.cwd)
      const lines = [
        `pi sandbox: ${state ? "ACTIVE" : "disabled"}`,
        "",
        "Network:",
        `  allow: ${c.network.allowedDomains.join(", ") || "(none)"}`,
        `  deny:  ${c.network.deniedDomains.join(", ") || "(none)"}`,
        "",
        "Filesystem:",
        `  denyRead:   ${c.filesystem.denyRead.join(", ") || "(none)"}`,
        `  allowRead:  ${c.filesystem.allowRead.join(", ") || "(none)"}`,
        `  allowWrite: ${c.filesystem.allowWrite.join(", ") || "(none)"}`,
        `  denyWrite:  ${c.filesystem.denyWrite.join(", ") || "(none)"}`,
        "",
        "Fixed policy: ssh/scp/sftp/rsync blocked; git/gh + package managers,",
        "nix, docker bypass the OS sandbox after path checks.",
      ]
      ctx.ui.notify(lines.join("\n"), "info")
    },
  })
}
