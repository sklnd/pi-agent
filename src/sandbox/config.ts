/**
 * Sandbox policy types, defaults, and config merging.
 *
 * This module is intentionally free of any `@earendil-works/pi-coding-agent`
 * runtime imports so its logic can be unit-tested with plain `node`.
 *
 * The policy schema maps onto Anthropic sandbox-runtime's (`srt`) config:
 * `network` and `filesystem` are passed straight through to srt (see srt.ts).
 */

export interface NetworkPolicy {
  /** Allow-list. Deny-by-default: an empty list means no network. `*.x.com`
   *  matches subdomains only, NOT the apex `x.com` — list both if you need it. */
  allowedDomains: string[];
  /** Checked before the allow-list; takes precedence. */
  deniedDomains: string[];
  /** Allow direct loopback connections */
  allowLocalBinding?: boolean;
}

export interface FilesystemPolicy {
  /** Read is allow-by-default; these paths are denied. */
  denyRead: string[];
  /** Re-allows paths inside a denied region. Takes precedence over denyRead. */
  allowRead: string[];
  /** Write is deny-by-default; only these paths are writable. */
  allowWrite: string[];
  /** Takes precedence over allowWrite. */
  denyWrite: string[];
}

export interface SandboxConfig {
  network: NetworkPolicy;
  filesystem: FilesystemPolicy;
}

/** A parsed project config: each section may be present only in part. */
export interface PartialSandboxConfig {
  network?: Partial<NetworkPolicy>;
  filesystem?: Partial<FilesystemPolicy>;
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
    allowLocalBinding: true,
  },
  filesystem: {
    denyRead: ["~"],
    allowRead: [
      ".",
      "~/.cache",
      "~/.cargo",
      "~/.config",
      "~/.local",
      "~/.nix-profile",
      "~/.npmrc",
      "~/.pnpm-store",
      "~/.rustup",
      "~/git",
      "~/Library",
    ],
    allowWrite: [
      ".",
      "/dev/fd/1",
      "/dev/fd/2",
      "/dev/null",
      "/dev/stderr",
      "/dev/stdout",
      "/private/tmp",
      "/private/var/folders",
      "/tmp",
      "~/.cache",
      "~/.cargo",
      "~/.local",
      "~/.npmrc",
      "~/.pnpm-store",
      "~/.rustup",
      "~/git",
      "~/Library/Caches",
      "~/Library/pnpm",
    ],
    denyWrite: ["**/.env", "**/.env.*", "*.pem", "*.key", "*.p12", "**/id_rsa", "**/id_ed25519"],
  },
};

/** Keep only values that the default policy already allows. */
function intersectAllowed<PolicyValue>(
  defaultValues: PolicyValue[],
  projectValues: PolicyValue[] | undefined,
): PolicyValue[] {
  if (projectValues === undefined) {
    return defaultValues;
  }
  const projectValueSet = new Set(projectValues);
  return defaultValues.filter((value) => projectValueSet.has(value));
}

/** Add project denials without letting the project remove a default denial. */
function unionDenied<PolicyValue>(
  defaultValues: PolicyValue[],
  projectValues: PolicyValue[] | undefined,
): PolicyValue[] {
  if (projectValues === undefined) {
    return defaultValues;
  }
  return [...new Set([...defaultValues, ...projectValues])];
}

/**
 * Merge a project policy into the default policy. A project may only tighten:
 * allow lists are intersected and deny lists are unioned. An absent list keeps
 * the default unchanged.
 */
export function mergeConfig(
  defaultConfig: SandboxConfig,
  projectConfig: PartialSandboxConfig,
): SandboxConfig {
  return {
    network: {
      allowedDomains: intersectAllowed(
        defaultConfig.network.allowedDomains,
        projectConfig.network?.allowedDomains,
      ),
      deniedDomains: unionDenied(
        defaultConfig.network.deniedDomains,
        projectConfig.network?.deniedDomains,
      ),
      // A project can turn loopback binding off, but never back on.
      allowLocalBinding:
        defaultConfig.network.allowLocalBinding &&
        (projectConfig.network?.allowLocalBinding ?? true),
    },
    filesystem: {
      denyRead: unionDenied(defaultConfig.filesystem.denyRead, projectConfig.filesystem?.denyRead),
      allowRead: intersectAllowed(
        defaultConfig.filesystem.allowRead,
        projectConfig.filesystem?.allowRead,
      ),
      allowWrite: intersectAllowed(
        defaultConfig.filesystem.allowWrite,
        projectConfig.filesystem?.allowWrite,
      ),
      denyWrite: unionDenied(
        defaultConfig.filesystem.denyWrite,
        projectConfig.filesystem?.denyWrite,
      ),
    },
  };
}

/** Keep only string entries; a non-array value means the field was malformed. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

type FieldValidator<Value> = (value: unknown) => Value | undefined;

type FieldValidators<Schema> = {
  [Field in keyof Schema]-?: FieldValidator<Schema[Field]>;
};

/**
 * The one place a config field is declared. Adding a policy field means adding
 * it to the interface and to this table; `satisfies` makes a mismatch a type
 * error.
 */
const NETWORK_FIELDS = {
  allowedDomains: stringList,
  deniedDomains: stringList,
  allowLocalBinding: booleanValue,
} satisfies FieldValidators<NetworkPolicy>;

const FILESYSTEM_FIELDS = {
  denyRead: stringList,
  allowRead: stringList,
  allowWrite: stringList,
  denyWrite: stringList,
} satisfies FieldValidators<FilesystemPolicy>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldName<Schema extends object>(
  fieldName: string,
  fieldValidators: FieldValidators<Schema>,
): fieldName is keyof Schema & string {
  return Object.hasOwn(fieldValidators, fieldName);
}

/** Validate each declared field independently; invalid fields are dropped. */
function pickValidFields<Schema extends object>(
  rawSection: unknown,
  fieldValidators: FieldValidators<Schema>,
): Partial<Schema> | undefined {
  if (!isRecord(rawSection)) {
    return undefined;
  }

  const validFields: Partial<Schema> = {};

  // Iterate the untrusted input keys but only keep names the schema declares.
  for (const fieldName of Object.keys(rawSection)) {
    if (!isFieldName(fieldName, fieldValidators)) {
      continue;
    }
    const parsedValue = fieldValidators[fieldName](rawSection[fieldName]);
    if (parsedValue !== undefined) {
      validFields[fieldName] = parsedValue;
    }
  }

  return Object.keys(validFields).length > 0 ? validFields : undefined;
}

/** Parse a possibly-partial config blob (from JSON.parse). Never throws, and
 *  drops fields with the wrong type so one bad config cannot break the tools. */
export function coercePartial(rawValue: unknown): PartialSandboxConfig {
  if (!isRecord(rawValue)) {
    return {};
  }

  const result: PartialSandboxConfig = {};

  const network = pickValidFields(rawValue.network, NETWORK_FIELDS);
  if (network) {
    result.network = network;
  }

  const filesystem = pickValidFields(rawValue.filesystem, FILESYSTEM_FIELDS);
  if (filesystem) {
    result.filesystem = filesystem;
  }

  return result;
}
