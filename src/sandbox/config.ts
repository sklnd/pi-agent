/**
 * Sandbox policy types, defaults, and config merging.
 *
 * This module is intentionally free of any `@earendil-works/pi-coding-agent`
 * runtime imports so its logic can be unit-tested with plain `node`.
 *
 * The policy schema is a superset of Anthropic sandbox-runtime's (`srt`)
 * config: `network` and `filesystem` are passed straight through to srt (see
 * srt.ts), while `enabled` is consumed by the extension itself.
 */

export interface NetworkPolicy {
  /** Allow-list. Deny-by-default: an empty list means no network. `*.x.com`
   *  matches subdomains only, NOT the apex `x.com` — list both if you need it. */
  allowedDomains: string[]
  /** Checked before the allow-list; takes precedence. */
  deniedDomains: string[]
}

export interface FilesystemPolicy {
  /** Read is allow-by-default; these paths are denied. */
  denyRead: string[]
  /** Re-allows paths inside a denied region. Takes precedence over denyRead. */
  allowRead: string[]
  /** Write is deny-by-default; only these paths are writable. */
  allowWrite: string[]
  /** Takes precedence over allowWrite. */
  denyWrite: string[]
}

export interface SandboxConfig {
  enabled: boolean
  network: NetworkPolicy
  filesystem: FilesystemPolicy
}

/**
 * Fallback baked-in policy, used when no project sandbox.json exists on disk.
 * This is the single source of truth for the default policy — nix-managed via
 * the vendored extension source (no separate JSON config to keep in sync).
 *
 * Posture: the agent gets the directory it was started in (`.`) plus `/tmp`;
 * the rest of $HOME is unreadable and unwritable to sandboxed commands — except
 * the toolchain roots re-allowed so mise (installs + nix profile) and git/nix
 * config are reachable under the sandbox.
 */
export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowedDomains: [
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "files.pythonhosted.org",
      "crates.io",
      "*.crates.io",
      "mise.en.dev",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~"],
    allowRead: [
      ".",
      "~/.cache",
      "~/.cargo",
      "~/.config",
      "~/.Library",
      "~/.local",
      "~/.nix-profile",
      "~/.npmrc",
      "~/.rustup",
      "~/git",
      "~/Library/Caches",
    ],
    allowWrite: [
      ".",
      "/dev/fd/1",
      "/dev/fd/2",
      "/dev/null",
      "/dev/stderr",
      "/dev/stdout",
      "/private/var/folders",
      "/tmp",
      "~/.cache",
      "~/.cargo",
      "~/.local",
      "~/.npmrc",
      "~/.rustup",
      "~/git",
      "~/Library/Caches",
    ],
    denyWrite: [
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "*.p12",
      "id_rsa",
      "id_ed25519",
    ],
  },
}

/** Right-hand array wins if present; otherwise keep the base. (Override replaces,
 *  it does not concatenate — a project sandbox.json fully controls each list.) */
function pick<T>(base: T[], override: T[] | undefined): T[] {
  return override !== undefined ? override : base
}

export function mergeConfig(
  base: SandboxConfig,
  o: Partial<SandboxConfig>,
): SandboxConfig {
  return {
    enabled: o.enabled ?? base.enabled,
    network: {
      allowedDomains: pick(
        base.network.allowedDomains,
        o.network?.allowedDomains,
      ),
      deniedDomains: pick(base.network.deniedDomains, o.network?.deniedDomains),
    },
    filesystem: {
      denyRead: pick(base.filesystem.denyRead, o.filesystem?.denyRead),
      allowRead: pick(base.filesystem.allowRead, o.filesystem?.allowRead),
      allowWrite: pick(base.filesystem.allowWrite, o.filesystem?.allowWrite),
      denyWrite: pick(base.filesystem.denyWrite, o.filesystem?.denyWrite),
    },
  }
}

/** Parse a possibly-partial config blob (from JSON.parse). Never throws. */
export function coercePartial(raw: unknown): Partial<SandboxConfig> {
  if (!raw || typeof raw !== "object") return {}
  return raw as Partial<SandboxConfig>
}
