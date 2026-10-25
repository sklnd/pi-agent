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
 * Config (merged; project-local overrides the baked-in DEFAULT_CONFIG;
 * the project file is optional — absent keys fall back to DEFAULT_CONFIG):
 *   <cwd>/.pi/sandbox.json               (project-local override)
 *
 * Command: `/sandbox` prints the active policy.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  createBashTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { coercePartial, DEFAULT_CONFIG, mergeConfig, type SandboxConfig } from "./config.ts";
import { isReadAllowed, isWriteAllowed } from "./fsguard.ts";
import { describeCommandPolicy } from "./policy.ts";
import { createPolicyBashOps, denyOps, srtAvailable, writeSrtSettings } from "./srt.ts";

function readJson(path: string): unknown {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`[sandbox] could not parse ${path}: ${e}`);
    return {};
  }
}

function loadConfig(cwd: string): SandboxConfig {
  const projectPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
  return mergeConfig(DEFAULT_CONFIG, coercePartial(readJson(projectPath)));
}

const READ_TOOLS = new Set(["read", "ls", "find", "grep"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);

  let state: {
    config: SandboxConfig;
    settingsPath: string;
    cleanup: () => void;
  } | null = null;

  // --- bash tool override: sandbox at execution time ---
  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      // Fail closed: with no sandbox state, refuse instead of running unsandboxed.
      const operations = state ? createPolicyBashOps(state.config, state.settingsPath) : denyOps;
      const tool = createBashTool(ctx?.cwd ?? localCwd, { operations });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // --- user_bash (`!` / `!!`) override: same policy ---
  pi.on("user_bash", () => {
    if (!state) return { operations: denyOps };
    return { operations: createPolicyBashOps(state.config, state.settingsPath) };
  });

  // --- pi-level filesystem enforcement on the built-in file tools ---
  pi.on("tool_call", (event, ctx) => {
    const read = READ_TOOLS.has(event.toolName);
    const write = WRITE_TOOLS.has(event.toolName);
    if (!read && !write) return;
    // Fail closed: no sandbox state means no policy to check against.
    if (!state) {
      return { block: true, reason: "sandbox: not initialised; file access blocked" };
    }
    const fs = state.config.filesystem;
    const cwd = ctx.cwd;
    const input = event.input as { path?: string };

    if (read) {
      const target = input.path ?? cwd;
      if (!isReadAllowed(fs, target, cwd)) {
        return {
          block: true,
          reason: `sandbox: read access to "${target}" is denied by policy`,
        };
      }
    } else {
      const target = input.path;
      if (target && !isWriteAllowed(fs, target, cwd)) {
        return {
          block: true,
          reason: `sandbox: write access to "${target}" is denied by policy`,
        };
      }
    }
  });

  // --- lifecycle ---
  pi.on("session_start", (_event, ctx) => {
    const config = loadConfig(ctx.cwd);

    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      ctx.ui.notify(`pi sandbox unsupported on ${platform}; bash is blocked`, "warning");
      return;
    }

    state?.cleanup(); // a repeated session_start must not leak the old settings dir
    const { path, cleanup } = writeSrtSettings(config);
    state = { config, settingsPath: path, cleanup };

    ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒 srt`));
    if (srtAvailable()) {
      ctx.ui.notify("pi sandbox active (srt)", "info");
    } else {
      ctx.ui.notify(
        "pi sandbox: srt not found; sandboxed commands will be blocked (fails closed)",
        "error",
      );
    }
  });

  pi.on("session_shutdown", () => {
    state?.cleanup();
    state = null;
  });

  // --- /sandbox: show the active policy ---
  pi.registerCommand("sandbox", {
    description: "Show the active pi sandbox policy",
    handler: async (_args, ctx) => {
      // Print the config that is actually enforced; only fall back to the disk
      // config when nothing is enforced yet.
      const disk = loadConfig(ctx.cwd);
      const c = state?.config ?? disk;
      const status = !state
        ? "inactive"
        : srtAvailable()
          ? "ACTIVE (srt)"
          : "ACTIVE but srt not found — sandboxed commands are blocked";
      const lines = [
        `pi sandbox: ${status}`,
        `config:     ${state ? "enforced (loaded at session start)" : "not enforced"}`,
        ...(state && JSON.stringify(disk) !== JSON.stringify(c)
          ? [
              "note:       .pi/sandbox.json changed since session start;",
              "            the enforced policy above still applies until restart",
            ]
          : []),
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
        "Fixed policy:",
        ...describeCommandPolicy(),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
