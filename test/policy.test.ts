import assert from "node:assert/strict"
import { homedir } from "node:os"
import { test } from "node:test"
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
  assert.equal(action("ssh user@host"), "block")
  assert.equal(action("scp a b:"), "block")
  assert.equal(action("sftp host"), "block")
  assert.equal(action("rsync -a a b"), "block")
  assert.equal(
    action("env FOO=1 ssh h"),
    "block",
    "wrapper + assignment skipped",
  )
  assert.equal(action("git status && ssh h"), "block", "any segment ssh blocks")
})

test("trusted tools bypass, others sandboxed", () => {
  assert.equal(action("git status"), "bypass")
  assert.equal(action("gh pr list"), "bypass")
  assert.equal(action("npm install"), "bypass")
  assert.equal(action("pnpm i"), "bypass")
  assert.equal(action("cargo build"), "bypass")
  assert.equal(action("mise install"), "bypass")
  assert.equal(action("docker ps"), "bypass")
  assert.equal(action("kubectl get pods"), "bypass")
  assert.equal(action("nix build .#x"), "bypass")
  assert.equal(action("nix-store --gc"), "bypass", "nix-* prefix")
  assert.equal(action("sudo git status"), "bypass", "wrapper skipped")
  assert.equal(action("ls -la"), "sandbox")
  assert.equal(action("curl https://example.com"), "sandbox")
})

test("mixed pipelines are not fully trusted -> sandbox", () => {
  assert.equal(action("git log | grep x"), "sandbox")
  assert.equal(
    action("git push; rm -rf ~"),
    "sandbox",
    "untrusted segment forces sandbox",
  )
})

test("pre-bypass path scan blocks protected paths", () => {
  assert.equal(action("git add key.pem"), "block", "denyWrite token")
  assert.equal(action("gh api /x < ~/.ssh/id_rsa"), "block", "denyRead token")
  assert.equal(action("git add .env"), "block")
  assert.equal(
    action("git clone https://github.com/a/b"),
    "bypass",
    "url ignored",
  )
  assert.equal(action("git commit -m msg"), "bypass", "flags ignored")
  assert.ok(deniedTokens("git add .env", DEFAULT_CONFIG, cwd).length > 0)
})

test("extractPrograms", () => {
  assert.deepEqual(extractPrograms("git log | grep x && npm t"), [
    "git",
    "grep",
    "npm",
  ])
  assert.deepEqual(extractPrograms("FOO=1 sudo -E ssh h"), ["ssh"])
})
