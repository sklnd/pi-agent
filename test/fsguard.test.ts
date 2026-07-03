import assert from "node:assert/strict"
import { homedir } from "node:os"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../src/sandbox/config.ts"
import {
  isReadAllowed,
  isWriteAllowed,
  matchPath,
} from "../src/sandbox/fsguard.ts"

const HOME = homedir()
const cwd = `${HOME}/git/proj` // realistic: cwd lives under $HOME
const fs = DEFAULT_CONFIG.filesystem

test("read: cwd and /tmp allowed, home denied", () => {
  assert.equal(isReadAllowed(fs, `${cwd}/src/a.ts`, cwd), true)
  assert.equal(
    isReadAllowed(fs, "src/a.ts", cwd),
    true,
    "relative resolves under cwd",
  )
  assert.equal(isReadAllowed(fs, "/tmp/x", cwd), true)
  assert.equal(
    isReadAllowed(fs, "/etc/hosts", cwd),
    true,
    "outside home is readable",
  )
  assert.equal(isReadAllowed(fs, "~/.ssh/id_rsa", cwd), false)
  assert.equal(isReadAllowed(fs, `${HOME}/.config/gh/hosts.yml`, cwd), false)
  assert.equal(isReadAllowed(fs, `${HOME}/Documents/x`, cwd), false)
})

test("write: deny by default, cwd + /tmp allowed, secrets denied", () => {
  assert.equal(isWriteAllowed(fs, `${cwd}/out.txt`, cwd), true)
  assert.equal(isWriteAllowed(fs, "/tmp/x", cwd), true)
  assert.equal(isWriteAllowed(fs, `${HOME}/x`, cwd), false, "home not writable")
  assert.equal(isWriteAllowed(fs, `${cwd}/.env`, cwd), false)
  assert.equal(isWriteAllowed(fs, `${cwd}/.env.local`, cwd), false)
  assert.equal(
    isWriteAllowed(fs, `${cwd}/certs/key.pem`, cwd),
    false,
    "basename glob *.pem",
  )
  assert.equal(isWriteAllowed(fs, `${cwd}/id_rsa`, cwd), false)
  assert.equal(isWriteAllowed(fs, `${cwd}/a.ts`, cwd), true)
})

test("matchPath glob semantics", () => {
  assert.equal(
    matchPath("/x/api.pem", "*.pem", cwd),
    true,
    "basename glob matches anywhere",
  )
  assert.equal(
    matchPath(`${cwd}/a/b/c.pem`, "**/*.pem", cwd),
    true,
    "** crosses slashes",
  )
  assert.equal(
    matchPath(`${cwd}/sub/f`, ".", cwd),
    true,
    "literal dir contains descendants",
  )
  assert.equal(
    matchPath(`${cwd}-sibling/f`, ".", cwd),
    false,
    "prefix must be a path boundary",
  )
})
