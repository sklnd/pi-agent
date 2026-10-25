import { expect, test } from "vitest";
import { coercePartial, DEFAULT_CONFIG, mergeConfig } from "../src/sandbox/config.ts";
import { toSrtSettings } from "../src/sandbox/srt.ts";

test("mergeConfig: override replaces arrays, keeps untouched sections", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    network: { allowedDomains: ["only.com"], deniedDomains: [] },
  });
  expect(merged.network.allowedDomains).toEqual(["only.com"]);
  expect(merged.filesystem.denyRead[0], "filesystem untouched").toBe("~");
});

test("mergeConfig: allowLocalBinding can be overridden", () => {
  expect(
    mergeConfig(DEFAULT_CONFIG, {
      network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false },
    }).network.allowLocalBinding,
  ).toBe(false);
});

test("mergeConfig: absent keys keep base", () => {
  expect(mergeConfig(DEFAULT_CONFIG, {})).toEqual(DEFAULT_CONFIG);
});

test("coercePartial tolerates junk", () => {
  expect(coercePartial(null)).toEqual({});
  expect(coercePartial("nope")).toEqual({});
  expect(coercePartial(42)).toEqual({});
});

test("pnpm store/datadirs are writable so pnpm keeps a stable store dir", () => {
  const { allowRead, allowWrite } = DEFAULT_CONFIG.filesystem;
  expect(allowWrite).toContain("~/Library/pnpm");
  expect(allowWrite).toContain("~/.pnpm-store");
  expect(allowRead, "reads covered by ~/Library").toContain("~/Library");
  expect(allowRead, "no macOS-invalid ~/.Library").not.toContain("~/.Library");
});

test("toSrtSettings projects onto srt schema", () => {
  const s = toSrtSettings(DEFAULT_CONFIG) as {
    network: { allowedDomains: string[]; allowLocalBinding?: boolean };
    filesystem: { allowWrite: string[] };
  };
  expect(s.network.allowedDomains).toContain("*.github.com");
  expect(s.network.allowLocalBinding, "direct loopback reachable (any port)").toBe(true);
  expect(s.filesystem.allowWrite).toContain(".");
});
