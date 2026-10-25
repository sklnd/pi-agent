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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { commandOnPath } from "../shared/executable.ts";
import type { SandboxConfig } from "./config.ts";
import { classifyCommand } from "./policy.ts";

/** Absolute path to the srt binary. nix pins this via env var; falls back to PATH. */
const SRT_BINARY = process.env.PI_SANDBOX_SRT_BIN || "srt";

/** True when the srt binary resolves. The sandbox fails closed without it. */
export function srtAvailable(): boolean {
  return commandOnPath(SRT_BINARY);
}

/** Project the extension's config onto srt's settings schema. */
export function toSrtSettings(config: SandboxConfig): Record<string, unknown> {
  return { network: config.network, filesystem: config.filesystem };
}

export interface SrtSettingsFile {
  path: string;
  cleanup: () => void;
}

/** Write srt settings to a private temp file. Returns the path and a cleanup fn. */
export function writeSrtSettings(config: SandboxConfig): SrtSettingsFile {
  const settingsDirectory = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
  const settingsPath = join(settingsDirectory, "srt-settings.json");

  // Mode 0600 keeps the policy file private to this user.
  writeFileSync(settingsPath, JSON.stringify(toSrtSettings(config), null, 2), {
    mode: 0o600,
  });

  return {
    path: settingsPath,
    cleanup: () => {
      try {
        rmSync(settingsDirectory, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort; the temp dir is still private.
      }
    },
  };
}

/** Quote one shell argument so the local shell passes it through unchanged. */
function quoteShellArgument(argument: string): string {
  return "'" + argument.replaceAll("'", "'\\''") + "'";
}

/** BashOperations that refuses every command. Used when the sandbox could not
 *  initialise, so commands fail closed instead of running unsandboxed. */
export const denyAllBashOperations: BashOperations = {
  async exec(_command, _cwd, options) {
    options.onData(Buffer.from("sandbox: not initialised; command not run\n"));
    return { exitCode: 126 };
  },
};

/**
 * BashOperations backend that applies the command policy per invocation:
 *   - block   → emit the reason and return a non-zero exit (surfaced to the model)
 *   - bypass  → pi's local bash backend (trusted tool, no OS sandbox)
 *   - sandbox → run under `srt --settings <file> -c <command>`
 */
export function createPolicyBashOps(
  config: SandboxConfig,
  settingsPath: string,
  localBashOperations: BashOperations,
): BashOperations {
  return {
    async exec(command, workingDirectory, execOptions) {
      const decision = classifyCommand(command, config, workingDirectory);

      if (decision.action === "block") {
        execOptions.onData(Buffer.from(`sandbox: ${decision.reason}\n`));
        return { exitCode: 126 };
      }

      if (decision.action === "bypass") {
        return localBashOperations.exec(command, workingDirectory, execOptions);
      }

      if (!srtAvailable()) {
        execOptions.onData(
          Buffer.from(`sandbox: srt not found ("${SRT_BINARY}"); command not run\n`),
        );
        return { exitCode: 126 };
      }

      const srtCommand = [
        quoteShellArgument(SRT_BINARY),
        "--settings",
        quoteShellArgument(settingsPath),
        "-c",
        quoteShellArgument(command),
      ].join(" ");
      return localBashOperations.exec(srtCommand, workingDirectory, execOptions);
    },
  };
}
