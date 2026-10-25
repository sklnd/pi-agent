import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/sandbox/config.ts";

const tempDirectory = mkdtempSync(join(tmpdir(), "pi-srt-sandbox-"));
const argsFile = join(tempDirectory, "args");
const fakeSrt = join(tempDirectory, "srt");
const settingsPath = join(tempDirectory, "settings with spaces.json");

writeFileSync(fakeSrt, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
chmodSync(fakeSrt, 0o755);
process.env.PI_SANDBOX_SRT_BIN = fakeSrt;
const { createPolicyBashOps } = await import("../src/sandbox/srt.ts");

afterAll(() => rmSync(tempDirectory, { recursive: true, force: true }));

test("sandboxed commands run through the local bash backend", async () => {
  const realLocalOperations = createLocalBashOperations();
  let localBackendCalled = false;
  const localBashOperations = {
    async exec(
      command: string,
      cwd: string,
      options: Parameters<typeof realLocalOperations.exec>[2],
    ) {
      localBackendCalled = true;
      return realLocalOperations.exec(command, cwd, options);
    },
  };

  const policyOperations = createPolicyBashOps(DEFAULT_CONFIG, settingsPath, localBashOperations);
  const command = "printf 'hi' && echo done";
  const execResult = await policyOperations.exec(command, process.cwd(), { onData: () => {} });

  expect(execResult.exitCode).toBe(0);
  expect(localBackendCalled, "sandbox path must use pi's tracked local backend").toBe(true);

  const srtArguments = readFileSync(argsFile, "utf-8").trimEnd().split("\n");
  expect(srtArguments).toEqual(["--settings", settingsPath, "-c", command]);
});
