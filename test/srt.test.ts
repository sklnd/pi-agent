import { expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/sandbox/config.ts";

// SRT_BIN is read when srt.ts is first imported, so set it before the import.
process.env.PI_SANDBOX_SRT_BIN = "/nonexistent/pi-test-srt";
const { createPolicyBashOps, denyOps } = await import("../src/sandbox/srt.ts");

test("denyOps refuses every command", async () => {
  let out = "";
  const result = await denyOps.exec("echo hi", process.cwd(), {
    onData: (data) => {
      out += data.toString();
    },
  });
  expect(result.exitCode).toBe(126);
  expect(out).toContain("not initialised");
});

test("sandboxed commands fail closed when srt is missing", async () => {
  const ops = createPolicyBashOps(DEFAULT_CONFIG, "/tmp/pi-test-settings.json");
  let out = "";
  const result = await ops.exec("ls -la", process.cwd(), {
    onData: (data) => {
      out += data.toString();
    },
  });
  expect(result.exitCode).toBe(126);
  expect(out).toContain("srt not found");
});
