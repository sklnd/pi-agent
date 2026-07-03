import assert from "node:assert/strict"
import { test } from "node:test"
import {
  coercePartial,
  DEFAULT_CONFIG,
  mergeConfig,
} from "../src/sandbox/config.ts"
import { toSrtSettings } from "../src/sandbox/srt.ts"

test("mergeConfig: override replaces arrays, keeps untouched sections", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    network: { allowedDomains: ["only.com"], deniedDomains: [] },
  })
  assert.deepEqual(merged.network.allowedDomains, ["only.com"])
  assert.equal(merged.filesystem.denyRead[0], "~", "filesystem untouched")
  assert.equal(merged.enabled, true)
})

test("mergeConfig: project can disable", () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { enabled: false }).enabled, false)
})

test("mergeConfig: absent keys keep base", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {})
  assert.deepEqual(merged, DEFAULT_CONFIG)
})

test("coercePartial tolerates junk", () => {
  assert.deepEqual(coercePartial(null), {})
  assert.deepEqual(coercePartial("nope"), {})
  assert.deepEqual(coercePartial(42), {})
  assert.deepEqual(coercePartial({ enabled: false }), { enabled: false })
})

test("toSrtSettings projects onto srt schema and drops `enabled`", () => {
  const s = toSrtSettings(DEFAULT_CONFIG) as {
    enabled?: unknown
    network: { allowedDomains: string[] }
    filesystem: { allowWrite: string[] }
  }
  assert.equal(s.enabled, undefined)
  assert.ok(s.network.allowedDomains.includes("*.github.com"))
  assert.ok(s.filesystem.allowWrite.includes("."))
})
