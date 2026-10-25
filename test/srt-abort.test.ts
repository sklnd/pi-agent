import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/sandbox/config.ts";

// Point the module at a fake srt binary that records when it is spawned.
const dir = mkdtempSync(join(tmpdir(), "pi-abort-"));
const marker = join(dir, "ran");
const tokenFile = join(dir, "token");
const fakeSrt = join(dir, "srt");
writeFileSync(
  fakeSrt,
  `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf '%s' "$PI_TEST_TOKEN" > ${JSON.stringify(tokenFile)}\n`,
);
chmodSync(fakeSrt, 0o755);
process.env.PI_SANDBOX_SRT_BIN = fakeSrt;
const { createPolicyBashOps } = await import("../src/sandbox/srt.ts");
const localBashOperations = createLocalBashOperations();

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("an already-aborted signal does not spawn the command", async () => {
  const policyOperations = createPolicyBashOps(
    DEFAULT_CONFIG,
    "/tmp/unused-settings.json",
    localBashOperations,
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    policyOperations.exec("ls", process.cwd(), {
      signal: controller.signal,
      onData: () => {},
    }),
  ).rejects.toThrow("aborted");
  expect(existsSync(marker), "command must not run").toBe(false);
});

test("the session environment is passed to the command", async () => {
  const policyOperations = createPolicyBashOps(
    DEFAULT_CONFIG,
    "/tmp/unused-settings.json",
    localBashOperations,
  );
  await policyOperations.exec("ls", process.cwd(), {
    onData: () => {},
    env: { ...process.env, PI_TEST_TOKEN: "sentinel" },
  });
  expect(readFileSync(tokenFile, "utf-8")).toBe("sentinel");
});
