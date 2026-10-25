/**
 * Notification backend selection and terminal escape sequences.
 *
 * This module is intentionally free of any `@earendil-works/pi-coding-agent`
 * runtime imports so its logic can be unit-tested with plain node.
 */

import { commandOnPath } from "../shared/executable.ts";

export interface Command {
  command: string;
  args: string[];
}

export { commandOnPath };

/** Keep notification text printable, single-line, and away from OSC delimiters. */
export function sanitize(text: string): string {
  return (
    text
      // oxlint-disable-next-line no-control-regex -- control characters are the point
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replaceAll(";", ",")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200)
  );
}

/**
 * Desktop notifier command, or null when the terminal should handle it.
 * SSH sessions return null so the notification lands on the local terminal.
 */
export function desktopCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  has: (name: string) => boolean,
  title: string,
  body: string,
): Command | null {
  if (env.SSH_CONNECTION || env.SSH_TTY) {
    return null;
  }

  const t = sanitize(title);
  const b = sanitize(body);

  if (platform === "darwin" && has("osascript")) {
    return {
      command: "osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "set bodyText to item 1 of argv as text",
        "-e",
        "set titleText to item 2 of argv as text",
        "-e",
        "display notification bodyText with title titleText",
        "-e",
        "end run",
        "--",
        b,
        t,
      ],
    };
  }

  if (platform === "linux" && has("notify-send")) {
    return {
      command: "notify-send",
      args: ["--app-name=pi", "--expire-time=8000", t, b],
    };
  }

  return null;
}

/**
 * Terminal notification sequence: OSC 99 for Kitty, OSC 777 otherwise.
 * Inside tmux wrap it in a DCS passthrough (tmux needs allow-passthrough all).
 * The id keeps separate pi sessions from replacing each other's notification.
 */
export function terminalSequence(
  title: string,
  body: string,
  env: NodeJS.ProcessEnv,
  id: string | number = process.pid,
): string {
  const t = sanitize(title);
  const b = sanitize(body);
  const kitty = env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty";
  const sequence = kitty
    ? `\x1b]99;i=${id}:d=0;${t}\x1b\\\x1b]99;i=${id}:p=body;${b}\x1b\\`
    : `\x1b]777;notify;${t};${b}\x07`;

  if (!env.TMUX) {
    return sequence;
  }
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}
