import { homedir } from "node:os"
import { expect, test } from "vitest"
import { DEFAULT_CONFIG } from "../src/sandbox/config.ts"
import {
  classifyCommand,
  deniedTokens,
  extractPrograms,
} from "../src/sandbox/policy.ts"

const HOME = homedir()
const cwd = `${HOME}/git/proj`
const action = (cmd: string) => classifyCommand(cmd, DEFAULT_CONFIG, cwd).action

test("ssh/scp/sftp/rsync are blocked", () => {
  expect(action("ssh user@host")).toBe("block")
  expect(action("scp a b:")).toBe("block")
  expect(action("sftp host")).toBe("block")
  expect(action("rsync -a a b")).toBe("block")
  expect(action("env FOO=1 ssh h"), "wrapper + assignment skipped").toBe(
    "block",
  )
  expect(action("git status && ssh h"), "any segment ssh blocks").toBe("block")
})

test("trusted tools bypass, others sandboxed", () => {
  expect(action("git status")).toBe("bypass")
  expect(action("gh pr list")).toBe("bypass")
  expect(action("npm install")).toBe("bypass")
  expect(action("pnpm i")).toBe("bypass")
  expect(action("cargo build")).toBe("bypass")
  expect(action("mise install")).toBe("bypass")
  expect(action("docker ps")).toBe("bypass")
  expect(action("kubectl get pods")).toBe("bypass")
  expect(action("nix build .#x")).toBe("bypass")
  expect(action("nix-store --gc"), "nix-* prefix").toBe("bypass")
  expect(action("sudo git status"), "wrapper skipped").toBe("bypass")
  expect(action("ls -la")).toBe("sandbox")
  expect(action("curl https://x")).toBe("sandbox")
})

test("mixed pipelines are not fully trusted -> sandbox", () => {
  expect(action("git log | grep x")).toBe("sandbox")
  expect(action("git push; rm -rf ~"), "untrusted segment forces sandbox").toBe(
    "sandbox",
  )
})

test("pre-bypass path scan blocks protected paths", () => {
  expect(action("git add key.pem"), "denyWrite token").toBe("block")
  expect(action("gh api /x < ~/.ssh/id_rsa"), "denyRead token").toBe("block")
  expect(action("git add .env")).toBe("block")
  expect(action("git clone https://github.com/a/b"), "url ignored").toBe(
    "bypass",
  )
  expect(action("git commit -m msg"), "flags ignored").toBe("bypass")
  expect(
    deniedTokens("git add .env", DEFAULT_CONFIG, cwd).length,
  ).toBeGreaterThan(0)
})

test("extractPrograms", () => {
  expect(extractPrograms("git log | grep x && npm t")).toEqual([
    "git",
    "grep",
    "npm",
  ])
  expect(extractPrograms("FOO=1 sudo -E ssh h")).toEqual(["ssh"])
})
