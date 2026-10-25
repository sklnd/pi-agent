import { expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/sandbox/config.ts";

// The srt path is read when srt.ts is first imported, so set it before the import.
process.env.PI_SANDBOX_SRT_BIN = "/nonexistent/pi-test-srt";
const { createPolicyBashOps, denyAllBashOperations } = await import("../src/sandbox/srt.ts");

const localBashOperations = {
  async exec(command: string, _cwd: string, options: { onData: (data: Buffer) => void }) {
    options.onData(Buffer.from(`local:${command}`));
    return { exitCode: 0 };
  },
};

test("denyAllBashOperations refuses every command", async () => {
  let output = "";
  const execResult = await denyAllBashOperations.exec("echo hi", process.cwd(), {
    onData: (data) => {
      output += data.toString();
    },
  });
  expect(execResult.exitCode).toBe(126);
  expect(output).toContain("not initialised");
});

test("sandboxed commands fail closed when srt is missing", async () => {
  const policyOperations = createPolicyBashOps(
    DEFAULT_CONFIG,
    "/tmp/pi-test-settings.json",
    localBashOperations,
  );
  let output = "";
  const execResult = await policyOperations.exec("ls -la", process.cwd(), {
    onData: (data) => {
      output += data.toString();
    },
  });
  expect(execResult.exitCode).toBe(126);
  expect(output).toContain("srt not found");
});

test("bypass runs through pi's local bash backend", async () => {
  const policyOperations = createPolicyBashOps(
    DEFAULT_CONFIG,
    "/tmp/pi-test-settings.json",
    localBashOperations,
  );
  let output = "";
  const execResult = await policyOperations.exec("git status", process.cwd(), {
    onData: (data) => {
      output += data.toString();
    },
  });
  expect(execResult.exitCode).toBe(0);
  expect(output).toBe("local:git status");
});
