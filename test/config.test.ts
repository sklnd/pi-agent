import { expect, test } from "vitest";
import { coercePartial, DEFAULT_CONFIG, mergeConfig } from "../src/sandbox/config.ts";
import { toSrtSettings } from "../src/sandbox/srt.ts";

test("mergeConfig: project config can only tighten arrays", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    network: { allowedDomains: ["github.com", "evil.com"], deniedDomains: ["evil.com"] },
    filesystem: {
      denyRead: ["/etc"],
      allowRead: ["~"],
      allowWrite: ["~"],
      denyWrite: ["secrets"],
    },
  });
  expect(merged.network.allowedDomains, "allow list intersected").toEqual(["github.com"]);
  expect(merged.network.deniedDomains, "deny list unioned").toContain("evil.com");
  expect(merged.filesystem.denyRead, "deny list unioned").toContain("/etc");
  expect(merged.filesystem.denyWrite, "deny list unioned").toContain("secrets");
  expect(merged.filesystem.allowRead, "new read allowance ignored").not.toContain("~");
  expect(merged.filesystem.allowWrite, "new write allowance ignored").not.toContain("~");
  for (const p of merged.filesystem.allowRead) {
    expect(DEFAULT_CONFIG.filesystem.allowRead).toContain(p);
  }
});

test("mergeConfig: project config cannot remove a default deny", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    network: { allowedDomains: DEFAULT_CONFIG.network.allowedDomains, deniedDomains: [] },
    filesystem: {
      denyRead: [],
      allowRead: DEFAULT_CONFIG.filesystem.allowRead,
      allowWrite: DEFAULT_CONFIG.filesystem.allowWrite,
      denyWrite: [],
    },
  });
  expect(merged.filesystem.denyRead).toEqual(DEFAULT_CONFIG.filesystem.denyRead);
  expect(merged.filesystem.denyWrite).toEqual(DEFAULT_CONFIG.filesystem.denyWrite);
});

test("mergeConfig: allowLocalBinding can only be turned off", () => {
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

test("coercePartial drops policy fields with the wrong type", () => {
  const p = coercePartial({
    network: { allowedDomains: "x", deniedDomains: ["ok", 5], allowLocalBinding: "yes" },
    filesystem: { denyRead: "~", allowRead: ["ok", 1], allowWrite: null, denyWrite: ["fine"] },
  });
  expect(p.network?.allowedDomains).toBeUndefined();
  expect(p.network?.deniedDomains).toEqual(["ok"]);
  expect(p.network?.allowLocalBinding).toBeUndefined();
  expect(p.filesystem?.denyRead).toBeUndefined();
  expect(p.filesystem?.allowRead).toEqual(["ok"]);
  expect(p.filesystem?.allowWrite).toBeUndefined();
  expect(p.filesystem?.denyWrite).toEqual(["fine"]);
});

test("coercePartial ignores fields the schema does not declare", () => {
  const parsed = coercePartial({
    network: { allowedDomains: [], unknownNetworkField: true },
    filesystem: { allowWrite: ["."], unknownFilesystemField: 1 },
  });
  expect(parsed.network).toEqual({ allowedDomains: [] });
  expect(parsed.filesystem).toEqual({ allowWrite: ["."] });
});

test("a malformed config falls back to the default policy", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, coercePartial({ filesystem: { denyRead: "~" } }));
  expect(merged.filesystem.denyRead).toEqual(DEFAULT_CONFIG.filesystem.denyRead);
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
