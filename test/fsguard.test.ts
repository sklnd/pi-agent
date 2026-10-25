import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/sandbox/config.ts";
import { isReadAllowed, isWriteAllowed, matchPath } from "../src/sandbox/fsguard.ts";

const HOME = homedir();
const cwd = `${HOME}/git/proj`;
const fs = DEFAULT_CONFIG.filesystem;

test("read: cwd and /tmp allowed, home denied", () => {
  expect(isReadAllowed(fs, `${cwd}/src/a.ts`, cwd)).toBe(true);
  expect(isReadAllowed(fs, "src/a.ts", cwd), "relative resolves under cwd").toBe(true);
  expect(isReadAllowed(fs, "/tmp/x", cwd)).toBe(true);
  expect(isReadAllowed(fs, "/etc/hosts", cwd), "outside home is readable").toBe(true);
  expect(isReadAllowed(fs, "~/.ssh/id_rsa", cwd)).toBe(false);
  expect(isReadAllowed(fs, `${HOME}/.config/gh/hosts.yml`, cwd)).toBe(true);
  expect(isReadAllowed(fs, `${HOME}/Documents/x`, cwd)).toBe(false);
});

test("write: deny by default, cwd + /tmp allowed, secrets denied", () => {
  expect(isWriteAllowed(fs, `${cwd}/out.txt`, cwd)).toBe(true);
  expect(isWriteAllowed(fs, "/tmp/x", cwd)).toBe(true);
  expect(isWriteAllowed(fs, "/private/tmp/x", cwd), "macOS /tmp resolves here").toBe(true);
  expect(isWriteAllowed(fs, `${HOME}/x`, cwd), "home not writable").toBe(false);
  expect(isWriteAllowed(fs, `${cwd}/.env`, cwd)).toBe(false);
  expect(isWriteAllowed(fs, `${cwd}/.env.local`, cwd)).toBe(false);
  expect(isWriteAllowed(fs, `${cwd}/certs/key.pem`, cwd), "basename glob *.pem").toBe(false);
  expect(isWriteAllowed(fs, `${cwd}/id_rsa`, cwd)).toBe(false);
  expect(isWriteAllowed(fs, `${cwd}/sub/.env`, cwd), "secret in a subdirectory").toBe(false);
  expect(isWriteAllowed(fs, `${cwd}/sub/.env.local`, cwd), "env variant in a subdirectory").toBe(
    false,
  );
  expect(isWriteAllowed(fs, `${cwd}/sub/id_rsa`, cwd), "key in a subdirectory").toBe(false);
  expect(isWriteAllowed(fs, `${cwd}/sub/id_ed25519`, cwd), "ed25519 in a subdirectory").toBe(false);
  expect(isWriteAllowed(fs, `${cwd}/a.ts`, cwd)).toBe(true);
  expect(isWriteAllowed(fs, `${HOME}/git/other/.env`, cwd), "secret in another writable repo").toBe(
    false,
  );
  expect(isWriteAllowed(fs, "/tmp/id_rsa", cwd), "secret under /tmp").toBe(false);
  expect(isWriteAllowed(fs, `${cwd}/sub/myid_rsa`, cwd), "basename must be exact").toBe(true);
});

test("symlinks are resolved before matching", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-outside-")));
  const cwdTmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-cwd-")));
  const policy = { denyRead: [outside], allowRead: [], allowWrite: [cwdTmp], denyWrite: [] };
  try {
    const secret = join(outside, "secret");
    writeFileSync(secret, "x");
    symlinkSync(secret, join(cwdTmp, "link"));
    expect(isReadAllowed(policy, join(cwdTmp, "link"), cwdTmp), "link to secret").toBe(false);
    expect(isWriteAllowed(policy, join(cwdTmp, "link"), cwdTmp), "overwrite via link").toBe(false);

    symlinkSync(outside, join(cwdTmp, "dirlink"));
    expect(
      isWriteAllowed(policy, join(cwdTmp, "dirlink/new.txt"), cwdTmp),
      "new file through a symlinked dir",
    ).toBe(false);

    expect(
      isWriteAllowed(policy, join(cwdTmp, "new.txt"), cwdTmp),
      "plain file still allowed",
    ).toBe(true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(cwdTmp, { recursive: true, force: true });
  }
});

test("matchPath glob semantics", () => {
  expect(matchPath("/x/api.pem", "*.pem", cwd), "basename glob matches anywhere").toBe(true);
  expect(matchPath(`${cwd}/a/b/c.pem`, "**/*.pem", cwd), "** crosses slashes").toBe(true);
  expect(matchPath(`${cwd}/sub/f`, ".", cwd), "literal dir contains descendants").toBe(true);
  expect(matchPath(`${cwd}-sibling/f`, ".", cwd), "prefix must be a path boundary").toBe(false);
});
