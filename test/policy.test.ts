import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/sandbox/config.ts";
import {
  ARBITRARY_EXEC_FORMS,
  classifyCommand,
  deniedTokens,
  describeCommandPolicy,
  extractPrograms,
  SSH_BLOCKLIST,
  TRUSTED_TOOLS,
} from "../src/sandbox/policy.ts";

const HOME = homedir();
const cwd = `${HOME}/git/proj`;
const action = (cmd: string) => classifyCommand(cmd, DEFAULT_CONFIG, cwd).action;

test("ssh/scp/sftp/rsync are blocked", () => {
  expect(action("ssh user@host")).toBe("block");
  expect(action("scp a b:")).toBe("block");
  expect(action("sftp host")).toBe("block");
  expect(action("rsync -a a b")).toBe("block");
  expect(action("env FOO=1 ssh h"), "wrapper + assignment skipped").toBe("block");
  expect(action("git status && ssh h"), "any segment ssh blocks").toBe("block");
});

test("trusted tools bypass, others sandboxed", () => {
  expect(action("git status")).toBe("bypass");
  expect(action("gh pr list")).toBe("bypass");
  expect(action("jj status")).toBe("bypass");
  expect(action("npm install")).toBe("bypass");
  expect(action("pnpm i")).toBe("bypass");
  expect(action("cargo build")).toBe("bypass");
  expect(action("mise install")).toBe("bypass");
  expect(action("docker ps")).toBe("bypass");
  expect(action("kubectl get pods")).toBe("bypass");
  expect(action("nix build .#x"), "nix is not trusted").toBe("sandbox");
  expect(action("nix-store --gc"), "nix-* is not trusted").toBe("sandbox");
  expect(action("sudo git status"), "wrapper skipped").toBe("bypass");
  expect(action("ls -la")).toBe("sandbox");
  expect(action("curl https://x")).toBe("sandbox");
});

test("wrapper flag values are not mistaken for the program", () => {
  expect(action("sudo -u git ssh host")).toBe("block");
  expect(extractPrograms("sudo -u git rm -rf ~")).toEqual(["rm"]);
  expect(action("sudo -u git rm -rf ~")).toBe("sandbox");
  expect(action("sudo --user git git status")).toBe("bypass");
  expect(action("env -u FOO git status"), "env -u takes a value").toBe("bypass");
  expect(action("stdbuf -o L git status"), "stdbuf -o takes a value").toBe("bypass");
});

test("env -S cannot hide the command behind a wrapper value", () => {
  expect(action("env -S 'rm -rf ~' git")).toBe("sandbox");
  expect(action("env -S 'ssh host' git")).toBe("sandbox");
  expect(action("env -S git status"), "plain env -S still finds git").toBe("bypass");
});

test("mixed pipelines are not fully trusted -> sandbox", () => {
  expect(action("git log | grep x")).toBe("sandbox");
  expect(action("git push; rm -rf ~"), "untrusted segment forces sandbox").toBe("sandbox");
});

test("PATH assignments never bypass", () => {
  expect(action("PATH=/tmp/evil git status")).toBe("block");
  expect(action("env PATH=/tmp/evil git status")).toBe("block");
  expect(action("PATH=/tmp/evil ls")).toBe("block");
});

test("command substitution and process substitution never bypass", () => {
  expect(action("git status $(rm -rf ~)")).toBe("sandbox");
  expect(action("git status `rm -rf ~`")).toBe("sandbox");
  expect(action("git status <(rm -rf ~)")).toBe("sandbox");
  expect(action("git status >(rm -rf ~)")).toBe("sandbox");
  expect(action("git status"), "plain trusted command still bypasses").toBe("bypass");
});

test("pre-bypass path scan blocks protected paths", () => {
  expect(action("git add key.pem"), "denyWrite token").toBe("block");
  expect(action("gh api /x < ~/.ssh/id_rsa"), "denyRead token").toBe("block");
  expect(action("git add .env")).toBe("block");
  expect(action("git clone https://github.com/a/b"), "url ignored").toBe("bypass");
  expect(action("git commit -m msg"), "flags ignored").toBe("bypass");
  expect(deniedTokens("git add .env", DEFAULT_CONFIG, cwd).length).toBeGreaterThan(0);
});

test("the trusted-tool path scan resolves symlinks", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-policy-outside-")));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "pi-policy-work-")));
  try {
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(join(outside, "secret"), join(work, "link"));

    const config = structuredClone(DEFAULT_CONFIG);
    config.filesystem.denyRead = [outside];
    config.filesystem.allowRead = [work];
    const command = "git diff --no-index /dev/null link";

    expect(deniedTokens(command, config, work)).not.toEqual([]);
    expect(classifyCommand(command, config, work).action).toBe("block");
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("flag values are scanned for protected paths", () => {
  expect(action("git commit --file=~/.ssh/id_rsa"), "denyRead flag value").toBe("block");
  expect(action("git add --path=.env"), "denyWrite flag value").toBe("block");
  expect(deniedTokens("git commit --file=~/.ssh/id_rsa", DEFAULT_CONFIG, cwd)).not.toEqual([]);
});

test("attached short-option values are scanned for protected paths", () => {
  expect(action(`git commit -F${HOME}/.ssh/id_rsa`)).toBe("block");
  expect(deniedTokens(`git commit -F${HOME}/.ssh/id_rsa`, DEFAULT_CONFIG, cwd)).not.toEqual([]);
  expect(action("git commit -F./.env"), "relative attached value").toBe("block");
  expect(action("git commit -F../other/.env"), "parent-relative attached value").toBe("block");
  expect(action("git commit -F .env"), "separate value already scanned").toBe("block");
});

test("trusted tools cannot run arbitrary commands via escapes", () => {
  expect(action("jj util exec sh")).toBe("block");
  expect(action("jj util -- exec sh"), "double-dash form").toBe("block");
  expect(action("jj util run sh")).toBe("block");
  expect(action("jj --config user.name=x status")).toBe("block");
  expect(action("jj --config-file /tmp/x.toml status")).toBe("block");
  expect(action("git -c core.pager='cat ~/.ssh/id_rsa' log")).toBe("block");
  expect(action("git --config-env=a=b log")).toBe("block");
  expect(action("git --exec-path=/tmp log")).toBe("block");
  expect(action("git --upload-pack=/tmp/x clone y")).toBe("block");
  expect(action("git clone -u /tmp/evil /tmp/repo"), "short upload-pack").toBe("block");
  expect(action("git --receive-pack=/tmp/x push")).toBe("block");
  expect(action("GIT_SSH_COMMAND=x git clone y")).toBe("block");
  expect(action("JJ_CONFIG=/tmp/x jj status")).toBe("block");
  expect(action("git status"), "plain git still bypasses").toBe("bypass");
  expect(action("jj status"), "plain jj still bypasses").toBe("bypass");
});

test("redirections do not split trusted commands into untrusted segments", () => {
  expect(extractPrograms("git log 2>&1")).toEqual(["git"]);
  expect(classifyCommand("git log 2>&1", DEFAULT_CONFIG, "/tmp").action).toBe("bypass");
  expect(classifyCommand("git log > /tmp/out 2>&1", DEFAULT_CONFIG, "/tmp").action).toBe("bypass");
  expect(classifyCommand("git log &> /tmp/out", DEFAULT_CONFIG, "/tmp").action).toBe("bypass");
  expect(classifyCommand("git status 2>&1 | cat", DEFAULT_CONFIG, "/tmp").action).toBe("sandbox");
});

test("a background command is its own segment", () => {
  expect(extractPrograms("git status & touch /tmp/pwned")).toEqual(["git", "touch"]);
  expect(action("git status & touch /tmp/pwned")).toBe("sandbox");
  expect(action("git status & ssh host")).toBe("block");
});

// Each documented escape form must really be blocked, so `/sandbox` cannot
// describe a rule that is not enforced.
const ESCAPE_SAMPLES: Record<string, string> = {
  "`jj util exec`": "jj util exec sh",
  "`jj --config`": "jj --config user.name=x status",
  "`jj --config-file`": "jj --config-file /tmp/x.toml status",
  "`git -c`": "git -c core.pager=cat log",
  "`git --config-env`": "git --config-env=a=b log",
  "`git --exec-path`": "git --exec-path=/tmp log",
  "`git --upload-pack`": "git --upload-pack=/tmp/x clone y",
  "`git clone -u`": "git clone -u /tmp/evil /tmp/repo",
  "`git --receive-pack`": "git --receive-pack=/tmp/x push",
  "`GIT_*`/`JJ_*` config env": "GIT_SSH_COMMAND=x git clone y",
  "`PATH=` assignment": "PATH=/tmp/evil git status",
};

test("describeCommandPolicy matches the enforced rules", () => {
  const [blocked, bypass] = describeCommandPolicy();
  for (const p of SSH_BLOCKLIST) {
    expect(blocked).toContain(p);
  }
  for (const [form, sample] of Object.entries(ESCAPE_SAMPLES)) {
    expect(blocked).toContain(form);
    expect(action(sample), form).toBe("block");
  }
  expect(ARBITRARY_EXEC_FORMS).toEqual(Object.keys(ESCAPE_SAMPLES));
  for (const tool of TRUSTED_TOOLS) {
    expect(bypass).toContain(tool);
  }
  expect(bypass).not.toMatch(/\bnix\b/);
});

test("extractPrograms", () => {
  expect(extractPrograms("git log | grep x && npm t")).toEqual(["git", "grep", "npm"]);
  expect(extractPrograms("FOO=1 sudo -E ssh h")).toEqual(["ssh"]);
});
