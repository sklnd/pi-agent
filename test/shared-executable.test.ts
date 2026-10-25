import { expect, test } from "vitest";
import { commandOnPath } from "../src/shared/executable.ts";

test("commandOnPath resolves absolute and PATH names", () => {
  expect(commandOnPath("/bin/sh")).toBe(true);
  expect(commandOnPath("definitely-not-a-real-binary-xyz")).toBe(false);
  expect(commandOnPath("sh", { PATH: "/bin" })).toBe(true);
});
