import { expect, test } from "vitest"
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
  expect(merged.network.allowedDomains).toEqual(["only.com"])
  expect(merged.filesystem.denyRead[0], "filesystem untouched").toBe("~")
  expect(merged.enabled).toBe(true)
})

test("mergeConfig: project can disable", () => {
  expect(mergeConfig(DEFAULT_CONFIG, { enabled: false }).enabled).toBe(false)
})

test("mergeConfig: absent keys keep base", () => {
  expect(mergeConfig(DEFAULT_CONFIG, {})).toEqual(DEFAULT_CONFIG)
})

test("coercePartial tolerates junk", () => {
  expect(coercePartial(null)).toEqual({})
  expect(coercePartial("nope")).toEqual({})
  expect(coercePartial(42)).toEqual({})
  expect(coercePartial({ enabled: false })).toEqual({ enabled: false })
})

test("toSrtSettings projects onto srt schema and drops `enabled`", () => {
  const s = toSrtSettings(DEFAULT_CONFIG) as {
    enabled?: unknown
    network: { allowedDomains: string[] }
    filesystem: { allowWrite: string[] }
  }
  expect(s.enabled).toBeUndefined()
  expect(s.network.allowedDomains).toContain("*.github.com")
  expect(s.filesystem.allowWrite).toContain(".")
})
