/**
 * agent-notify pi extension — notify when the agent settles and is waiting
 * for the next prompt.
 *
 * Uses a desktop notifier when one is available (osascript on macOS,
 * notify-send on Linux), otherwise a terminal OSC notification. SSH sessions
 * always use the terminal sequence so the notification lands on the local
 * terminal. Inside tmux the sequence is wrapped in a DCS passthrough; tmux
 * needs `set -g allow-passthrough all` so background tabs reach the outer
 * terminal.
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandOnPath, desktopCommand, terminalSequence } from "./notify.ts";

/**
 * Send a notification, using a desktop notifier when one is available and a
 * terminal sequence otherwise (or when the notifier fails).
 */
function notify(title: string, body: string): void {
  const command = desktopCommand(process.platform, process.env, commandOnPath, title, body);
  const fallback = () => process.stdout.write(terminalSequence(title, body, process.env));

  if (!command) {
    fallback();
    return;
  }

  let fellBack = false;
  const fallbackOnce = () => {
    if (fellBack) {
      return;
    }
    fellBack = true;
    fallback();
  };

  try {
    const child = spawn(command.command, command.args, { detached: true, stdio: "ignore" });
    child.once("error", fallbackOnce);
    // A notifier that exists but fails (no D-Bus, osascript syntax) still gets
    // the terminal fallback.
    child.once("exit", (code) => {
      if (code !== 0) {
        fallbackOnce();
      }
    });
    child.unref();
  } catch {
    fallbackOnce();
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", ({ aborted }, ctx) => {
    if (aborted || ctx.mode !== "tui") {
      return;
    }
    const session = pi.getSessionName() || basename(ctx.cwd);
    notify("π ready", `${session} — waiting for input`);
  });

  pi.registerCommand("notify", {
    description: "Send a test notification through the agent-notify backend",
    handler: async (_args, ctx) => {
      notify("π ready", "Test notification");
      ctx.ui.notify("Test notification sent", "info");
    },
  });
}
