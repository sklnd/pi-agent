# AGENTS.md

`pi-agent` — configuration and extensions for the [pi](https://github.com/earendil-works/pi) coding agent. Managed as a TypeScript project and consumed as a nix flake (by `nix-config`).

## Layout

```
pi/settings.json      # pi user settings (packages, default tools)
pi/APPEND_SYSTEM.md   # curated global append system prompt
src/sandbox/          # the "sandbox" pi extension (jiti-loaded by pi, NO build step)
src/agent-notify/     # the "agent-notify" extension (same constraints)
src/shared/           # helpers shared by the extensions
test/                 # Unit tests
flake.nix             # packages.pi-config + passthroughs + homeManagerModules.default
nix/hm-module.nix     # home-manager module that installs pi + srt and wires the config
```

The flake vendors `src/sandbox/*.ts`, `src/agent-notify/*.ts`, `src/shared/*.ts`, `pi/settings.json`, and `pi/APPEND_SYSTEM.md` into `$out` matching pi's `$PI_CODING_AGENT_DIR` layout (`settings.json`, `APPEND_SYSTEM.md`, `extensions/{sandbox,agent-notify,shared}/*.ts`). The default sandbox policy lives in code as `DEFAULT_CONFIG` (`config.ts`).

The flake also declares `llm-agents` (https://github.com/numtide/llm-agents.nix) as an input and exposes a home-manager module (`homeManagerModules.default`, `nix/hm-module.nix`) that installs `pi` + `srt` from llm-agents, sets `PI_CODING_AGENT_DIR` / `PI_SANDBOX_SRT_BIN`, symlinks extensions into `<configDir>/extensions`, symlinks the curated `APPEND_SYSTEM.md` into `<configDir>/APPEND_SYSTEM.md`, and merges `pi/settings.json` (+ optional `programs.pi-agent.settings`) into a mutable `<configDir>/settings.json` on activation (the `configDir` option defaults to `~/.config/pi`). This ensures curated packages/extensions sync without drift across machines while machine-local runtime state (like `defaultModel` chosen via `Ctrl+S`) is preserved. The merge itself is `nix/merge-settings.sh` (read and run by the module, no build step) and is override-by-key except `packages`, which is a union of curated + locally-installed packages so interactive installs survive a switch; a package removed from curation is still dropped via the `.pi-curated-packages.json` state file. `nix/merge-settings.test.sh` exercises it (including the two-switch state round-trip) and is wired up as `checks.<system>.settings-merge` for `nix flake check`. `nix-config` imports this module instead of maintaining its own inline `pi.nix`, so this flake owns the whole setup. The flake's `packages.pi` and `packages.srt` are passthroughs from llm-agents for convenience.

## Toolchain

Node 26 + pnpm 12 via [mise](https://mise.jdx.dev) (`mise.toml`). TypeScript 7 `tsc` for typechecking, `oxlint`/`oxfmt` for lint/format, `vitest` for tests. `just` is the task runner (`mise.toml` aliases `make`→`just`).

`just fix` runs `treefmt` (`treefmt.toml`: alejandra + oxfmt). `treefmt` is **required on PATH** and is not installed by mise/pnpm — it comes from the maintainer's nix config. If you don't have it, run the underlying formatters directly (`alejandra --check .`, `oxfmt --check .`).

```sh
just install      # mise install + pnpm install
just check        # full: check-js + check-nix
just check-js     # fmt-check + lint-js + typecheck + test-js  (no nix; run in the sandbox)
just lint         # lint-js (oxlint) + lint-nix (statix, deadnix)
just test         # test-js (vitest) + test-nix (nix flake check)
just build        # nix build .#pi-config
just show         # build + list the assembled tree
just fix          # treefmt then oxlint --fix
just update       # nix flake update
```

Note: `nix` commands (check/build/show/update) need the nix daemon, which is not available inside the pi sandbox — run those outside the agent. `just check-js` (fmt-check + lint-js + typecheck + test-js) does not need nix and is the sandbox-safe check; `just check` adds `check-nix` = `lint-nix` + `test-nix`. `just test` runs both `test-js` and `test-nix`. `lint-nix` runs `statix check .` and `deadnix --fail .` (both already on PATH via nix-config). All source formatting goes through `treefmt`; `just fmt-check` runs `treefmt --fail-on-change`, which rewrites files before exiting non-zero — the exit status is what CI keys on.

`pnpm` scripts mirror the JS-only checks: `test` (`vitest run`), `test:watch` (`vitest`), `typecheck` (`tsc --noEmit`), `lint` (`oxlint`), `format`/`format:check` (`oxfmt`).

## The sandbox extension — invariants

The extension layers OS-level sandboxing (`srt`) with pi-level filesystem enforcement. When editing it, preserve these invariants:

1. **No build step.** Pi loads `src/sandbox/*.ts` directly via jiti. Every runtime import must use the `.ts` extension (`./config.ts`, not `./config`) and `@earendil-works/pi-coding-agent` must be importable at runtime.
2. **Pure modules are pi-import-free.** `config.ts`, `fsguard.ts`, and `policy.ts` must NOT import anything from `@earendil-works/pi-coding-agent` at runtime — only type-only imports (which node strips) are allowed in `srt.ts`. This keeps them unit-testable with plain `node`. Don't add runtime pi imports to these files.
3. **`DEFAULT_CONFIG` (config.ts) is the single source of truth for the default policy.** It's nix-managed via the vendored source — there's no separate `sandbox.json` to keep in sync. Don't reintroduce a JSON duplicate.
4. **Fixed, non-configurable policy** (policy.ts): `ssh`/`scp`/`sftp`/`rsync` are always **blocked**, as are the forms that let a trusted tool run an arbitrary program (`jj util exec`, `jj --config`, `git -c`/`--config-env`/`--exec-path`/`--upload-pack`/`--receive-pack`, `git clone -u`, and `GIT_*`/`JJ_*` config env); `git`/`gh`/`jj` + package managers + `docker`/`kubectl`/`mise` **bypass** (but `nix`, which can install packages and reach the daemon, does not) the OS sandbox (after a static deny-path token scan); everything else runs **sandboxed** under `srt`. A mixed pipeline (any untrusted segment) falls back to sandbox — bypass requires every segment trusted. If `srt` is missing the sandbox fails closed: sandboxed commands are refused rather than run unsandboxed.
5. **fs semantics mirror srt.** `fsguard.ts` must agree with srt: read is allow-by-default (`denyRead` denies, `allowRead` re-allows/wins); write is deny-by-default (`allowWrite` allows, `denyWrite` denies/wins). Bare-basename globs (`*.pem`) match the basename anywhere; path globs match the full expanded path; literal paths match themselves or descendants (with a path boundary, not a string prefix). It runs in-process on every platform, unlike srt's macOS-only globs.
6. **A project config can only tighten the policy.** `mergeConfig` intersects allow lists (`allowedDomains`, `allowRead`, `allowWrite`) with the defaults and unions deny lists (`deniedDomains`, `denyRead`, `denyWrite`), and can only turn `allowLocalBinding` off. A project `sandbox.json` must never be able to widen access.
7. **No npm in nix.** The extension is dependency-free at runtime (pi provides its API; `srt` is a separate binary pinned via `PI_SANDBOX_SRT_BIN` or PATH). The flake only copies source — never add a build step or npm dependency to the nix package.

## Config

- Policy starts from `DEFAULT_CONFIG` (config.ts) and can be tightened by `<cwd>/.pi/sandbox.json` (project-local, optional). Allow lists are intersected and deny lists unioned, so the project file cannot widen access.
- `/sandbox` prints the active policy.

## Conventions

- `just check-js` before declaring work done inside the sandbox; run `just check` (JS + nix) outside. Fix lint/format failures with `just fix`.
- Tests live in `test/*.test.ts` (vitest) and cover the pure logic in `config.ts`/`fsguard.ts`/`policy.ts` — add tests when changing that logic. There are no integration tests for the pi wiring in `index.ts`/`srt.ts` by design.
- The home-manager settings merge is the exception: its shell+jq logic lives in `nix/merge-settings.sh` and is tested by `nix/merge-settings.test.sh` (run via `nix flake check`, or directly with `bash nix/merge-settings.test.sh`). Don't add a parallel vitest copy — one harness is enough.
- Keep file header comments accurate; they document each module's role and the no-pi-import invariant.
- This repo is also a jj/git repo (`.jj` exists) — be careful with `git`/`jj` commands that could rewrite history.
