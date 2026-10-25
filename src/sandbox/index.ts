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
 * Config (merged; a project file may only tighten the baked-in DEFAULT_CONFIG;
 * the project file is optional — absent keys fall back to DEFAULT_CONFIG):
 *   <cwd>/.pi/sandbox.json               (project-local, can only tighten)
 *
 * Command: `/sandbox` prints the active policy.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  createBashTool,
  createLocalBashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { coercePartial, DEFAULT_CONFIG, mergeConfig, type SandboxConfig } from "./config.ts";
import { isReadAllowed, isWriteAllowed } from "./fsguard.ts";
import { describeCommandPolicy } from "./policy.ts";
import {
  createPolicyBashOps,
  denyAllBashOperations,
  srtAvailable,
  writeSrtSettings,
} from "./srt.ts";

interface SandboxState {
  config: SandboxConfig;
  settingsPath: string;
  cleanup: () => void;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    console.error(`[sandbox] could not parse ${path}: ${error}`);
    return {};
  }
}

function loadConfig(cwd: string): SandboxConfig {
  const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
  return mergeConfig(DEFAULT_CONFIG, coercePartial(readJson(projectConfigPath)));
}

const READ_TOOLS = new Set(["read", "ls", "find", "grep"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export default function (pi: ExtensionAPI) {
  const initialWorkingDirectory = process.cwd();
  const localBashTool = createBashTool(initialWorkingDirectory);
  const localBashOperations = createLocalBashOperations();

  // `null` means no policy is enforced yet. Every command path checks this and
  // fails closed rather than falling back to an unsandboxed run.
  let activeSandbox: SandboxState | null = null;

  // --- bash tool override: sandbox at execution time ---
  pi.registerTool({
    ...localBashTool,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, context) {
      const operations = activeSandbox
        ? createPolicyBashOps(activeSandbox.config, activeSandbox.settingsPath, localBashOperations)
        : denyAllBashOperations;
      const bashTool = createBashTool(context?.cwd ?? initialWorkingDirectory, { operations });
      return bashTool.execute(id, params, signal, onUpdate);
    },
  });

  // --- user_bash (`!` / `!!`) override: same policy ---
  pi.on("user_bash", () => {
    if (!activeSandbox) {
      return { operations: denyAllBashOperations };
    }
    return {
      operations: createPolicyBashOps(
        activeSandbox.config,
        activeSandbox.settingsPath,
        localBashOperations,
      ),
    };
  });

  // --- pi-level filesystem enforcement on the built-in file tools ---
  pi.on("tool_call", (event, context) => {
    const isReadTool = READ_TOOLS.has(event.toolName);
    const isWriteTool = WRITE_TOOLS.has(event.toolName);
    if (!isReadTool && !isWriteTool) {
      return;
    }

    if (!activeSandbox) {
      return { block: true, reason: "sandbox: not initialised; file access blocked" };
    }

    const filesystemPolicy = activeSandbox.config.filesystem;
    const workingDirectory = context.cwd;
    const toolInput = event.input as { path?: string };

    if (isReadTool) {
      // Reading without a path means listing/searching the working directory.
      const targetPath = toolInput.path ?? workingDirectory;
      if (!isReadAllowed(filesystemPolicy, targetPath, workingDirectory)) {
        return {
          block: true,
          reason: `sandbox: read access to "${targetPath}" is denied by policy`,
        };
      }
    } else {
      const targetPath = toolInput.path;
      if (targetPath && !isWriteAllowed(filesystemPolicy, targetPath, workingDirectory)) {
        return {
          block: true,
          reason: `sandbox: write access to "${targetPath}" is denied by policy`,
        };
      }
    }
  });

  // --- lifecycle ---
  pi.on("session_start", (_event, context) => {
    const sandboxConfig = loadConfig(context.cwd);
    const platform = process.platform;

    if (platform !== "darwin" && platform !== "linux") {
      context.ui.notify(`pi sandbox unsupported on ${platform}; bash is blocked`, "warning");
      return;
    }

    // A repeated session_start must not leak the previous temp settings dir.
    activeSandbox?.cleanup();

    const { path: settingsPath, cleanup } = writeSrtSettings(sandboxConfig);
    activeSandbox = { config: sandboxConfig, settingsPath, cleanup };

    context.ui.setStatus("sandbox", context.ui.theme.fg("accent", `🔒 srt`));
    if (srtAvailable()) {
      context.ui.notify("pi sandbox active (srt)", "info");
    } else {
      context.ui.notify(
        "pi sandbox: srt not found; sandboxed commands will be blocked (fails closed)",
        "error",
      );
    }
  });

  pi.on("session_shutdown", () => {
    activeSandbox?.cleanup();
    activeSandbox = null;
  });

  // --- /sandbox: show the active policy ---
  pi.registerCommand("sandbox", {
    description: "Show the active pi sandbox policy",
    handler: async (_args, context) => {
      // Show the config that is actually enforced. Only read the disk config as
      // a fallback when no session policy has been loaded yet.
      const diskConfig = loadConfig(context.cwd);
      const activeConfig = activeSandbox?.config ?? diskConfig;

      let sandboxStatus: string;
      if (!activeSandbox) {
        sandboxStatus = "inactive";
      } else if (srtAvailable()) {
        sandboxStatus = "ACTIVE (srt)";
      } else {
        sandboxStatus = "ACTIVE but srt not found — sandboxed commands are blocked";
      }

      const configStatus = activeSandbox ? "enforced (loaded at session start)" : "not enforced";
      const configChangedSinceStart =
        activeSandbox !== null && JSON.stringify(diskConfig) !== JSON.stringify(activeConfig);
      const configChangedNote = configChangedSinceStart
        ? [
            "note:       .pi/sandbox.json changed since session start;",
            "            the enforced policy above still applies until restart",
          ]
        : [];

      const lines = [
        `pi sandbox: ${sandboxStatus}`,
        `config:     ${configStatus}`,
        ...configChangedNote,
        "",
        "Network:",
        `  allow: ${activeConfig.network.allowedDomains.join(", ") || "(none)"}`,
        `  deny:  ${activeConfig.network.deniedDomains.join(", ") || "(none)"}`,
        "",
        "Filesystem:",
        `  denyRead:   ${activeConfig.filesystem.denyRead.join(", ") || "(none)"}`,
        `  allowRead:  ${activeConfig.filesystem.allowRead.join(", ") || "(none)"}`,
        `  allowWrite: ${activeConfig.filesystem.allowWrite.join(", ") || "(none)"}`,
        `  denyWrite:  ${activeConfig.filesystem.denyWrite.join(", ") || "(none)"}`,
        "",
        "Fixed policy:",
        ...describeCommandPolicy(),
      ];
      context.ui.notify(lines.join("\n"), "info");
    },
  });
}
