import { homedir } from "node:os"
import { expect, test } from "vitest"
import { DEFAULT_CONFIG } from "../src/sandbox/config.ts"
import {
  isReadAllowed,
  isWriteAllowed,
  matchPath,
} from "../src/sandbox/fsguard.ts"

const HOME = homedir()
const cwd = `${HOME}/git/proj`
const fs = DEFAULT_CONFIG.filesystem

test("read: cwd and /tmp allowed, home denied", () => {
  expect(isReadAllowed(fs, `${cwd}/src/a.ts`, cwd)).toBe(true)
  expect(
    isReadAllowed(fs, "src/a.ts", cwd),
    "relative resolves under cwd",
  ).toBe(true)
  expect(isReadAllowed(fs, "/tmp/x", cwd)).toBe(true)
  expect(isReadAllowed(fs, "/etc/hosts", cwd), "outside home is readable").toBe(
    true,
  )
  expect(isReadAllowed(fs, "~/.ssh/id_rsa", cwd)).toBe(false)
  expect(isReadAllowed(fs, `${HOME}/.config/gh/hosts.yml`, cwd)).toBe(false)
  expect(isReadAllowed(fs, `${HOME}/Documents/x`, cwd)).toBe(false)
})

test("write: deny by default, cwd + /tmp allowed, secrets denied", () => {
  expect(isWriteAllowed(fs, `${cwd}/out.txt`, cwd)).toBe(true)
  expect(isWriteAllowed(fs, "/tmp/x", cwd)).toBe(true)
  expect(isWriteAllowed(fs, `${HOME}/x`, cwd), "home not writable").toBe(false)
  expect(isWriteAllowed(fs, `${cwd}/.env`, cwd)).toBe(false)
  expect(isWriteAllowed(fs, `${cwd}/.env.local`, cwd)).toBe(false)
  expect(
    isWriteAllowed(fs, `${cwd}/certs/key.pem`, cwd),
    "basename glob *.pem",
  ).toBe(false)
  expect(isWriteAllowed(fs, `${cwd}/id_rsa`, cwd)).toBe(false)
  expect(isWriteAllowed(fs, `${cwd}/a.ts`, cwd)).toBe(true)
})

test("matchPath glob semantics", () => {
  expect(
    matchPath("/x/api.pem", "*.pem", cwd),
    "basename glob matches anywhere",
  ).toBe(true)
  expect(
    matchPath(`${cwd}/a/b/c.pem`, "**/*.pem", cwd),
    "** crosses slashes",
  ).toBe(true)
  expect(
    matchPath(`${cwd}/sub/f`, ".", cwd),
    "literal dir contains descendants",
  ).toBe(true)
  expect(
    matchPath(`${cwd}-sibling/f`, ".", cwd),
    "prefix must be a path boundary",
  ).toBe(false)
})
