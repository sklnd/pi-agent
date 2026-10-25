import { expect, test } from "vitest";
import {
  commandOnPath,
  desktopCommand,
  sanitize,
  terminalSequence,
} from "../src/agent-notify/notify.ts";

const has = (name: string) => name === "osascript" || name === "notify-send";

test("macOS uses osascript with argv (no shell interpolation)", () => {
  const command = desktopCommand("darwin", {}, has, "π ready", "proj — waiting");
  expect(command?.command).toBe("osascript");
  expect(command?.args).toContain("--");
  expect(command?.args.slice(-2)).toEqual(["proj — waiting", "π ready"]);
});

test("Linux uses notify-send when installed, otherwise terminal", () => {
  const command = desktopCommand("linux", { PATH: "/bin" }, has, "π ready", "body");
  expect(command?.command).toBe("notify-send");
  expect(command?.args).toEqual(["--app-name=pi", "--expire-time=8000", "π ready", "body"]);
  expect(desktopCommand("linux", {}, () => false, "π", "b")).toBeNull();
});

test("SSH always falls back to the terminal", () => {
  expect(desktopCommand("darwin", { SSH_CONNECTION: "1 2 3 4" }, has, "π", "b")).toBeNull();
  expect(desktopCommand("linux", { SSH_TTY: "/dev/pts/1" }, has, "π", "b")).toBeNull();
});

test("sanitize strips control characters and OSC separators", () => {
  expect(sanitize("a\u0007b;c\n d")).toBe("a b,c d");
  expect(sanitize("a\u009bb")).toBe("a b");
});

test("terminal sequence uses Kitty OSC 99 and OSC 777 for the rest", () => {
  expect(terminalSequence("π", "b", {})).toBe("\x1b]777;notify;π;b\x07");
  expect(terminalSequence("π", "b", { KITTY_WINDOW_ID: "1" })).toContain("\x1b]99;");
  expect(terminalSequence("π", "b", { TERM: "xterm-kitty" })).toContain("\x1b]99;");
});

test("Kitty notification id is unique per session", () => {
  expect(terminalSequence("π", "b", { TERM: "xterm-kitty" }, 42)).toContain("i=42:");
});

test("tmux wraps the sequence in a DCS passthrough", () => {
  const wrapped = terminalSequence("π", "b", { TMUX: "/tmp/tmux-1" });
  expect(wrapped.startsWith("\x1bPtmux;\x1b\x1b]777;")).toBe(true);
  expect(wrapped.endsWith("\x07\x1b\\")).toBe(true);
});

test("commandOnPath resolves absolute and PATH names", () => {
  expect(commandOnPath("/bin/sh")).toBe(true);
  expect(commandOnPath("definitely-not-a-real-binary-xyz")).toBe(false);
});
