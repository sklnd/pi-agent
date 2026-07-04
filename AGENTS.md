# AGENTS.md

`pi-agent` — configuration and extensions for the [pi](https://github.com/earendil-works/pi) coding agent. Managed as a TypeScript project and consumed as a nix flake (by `nix-config`).

## Layout

```
pi/settings.json      # pi user settings (packages, etc.)
pi/sandbox.json       # default (global) sandbox policy
src/sandbox/          # the "sandbox" pi extension (jiti-loaded by pi, NO build step)
test/                 # Unit tests 
flake.nix             # packages.pi-config = assembled tree consumed by nix-config
```

The flake vendors `src/sandbox/*.ts` + `pi/*.json` into `$out` matching pi's `$PI_CODING_AGENT_DIR` layout (`settings.json`, `sandbox.json`, `extensions/sandbox/*.ts`).

## Toolchain

Node 26 + pnpm 11 via [mise](https://mise.jdx.dev) (`mise.toml`). TypeScript 7 `tsgo` for typechecking, `oxlint`/`oxfmt` for lint/format, `node:test` for tests. `just` is the task runner (`mise.toml` aliases `make`→`just`).

```sh
just install      # mise install + pnpm install
just check        # fmt-check + lint + typecheck + test  (run this after changes)
just test         # node --test test/*.test.ts
just build        # nix build .#pi-config
just show         # build + list the assembled tree
just fix          # oxfmt --write + oxlint --fix + nix fmt
just update       # nix flake update
```

`pnpm` scripts mirror the JS-only checks: `test`, `typecheck` (`tsgo --noEmit`), `lint` (`oxlint`), `format`/`format:check` (`oxfmt`).

## The sandbox extension — invariants

The extension layers OS-level sandboxing (`srt`) with pi-level filesystem enforcement. When editing it, preserve these invariants:

1. **No build step.** Pi loads `src/sandbox/*.ts` directly via jiti. Every runtime import must use the `.ts` extension (`./config.ts`, not `./config`) and `@earendil-works/pi-coding-agent` must be importable at runtime.
2. **Pure modules are pi-import-free.** `config.ts`, `fsguard.ts`, and `policy.ts` must NOT import anything from `@earendil-works/pi-coding-agent` at runtime — only type-only imports (which node strips) are allowed in `srt.ts`. This keeps them unit-testable with plain `node`. Don't add runtime pi imports to these files.
3. **Keep `DEFAULT_CONFIG` (config.ts) and `pi/sandbox.json` in sync.** Both express the same baked-in policy; the JSON is the nix-managed global default and the const is the in-code fallback. If you change one, change the other.
4. **Fixed, non-configurable policy** (policy.ts): `ssh`/`scp`/`sftp`/`rsync` are always **blocked**; `git`/`gh` + package managers + `nix`/`nix-*` + `docker`/`kubectl`/`mise` **bypass** the OS sandbox (after a static deny-path token scan); everything else runs **sandboxed** under `srt`. A mixed pipeline (any untrusted segment) falls back to sandbox — bypass requires every segment trusted.
5. **fs semantics mirror srt.** `fsguard.ts` must agree with srt: read is allow-by-default (`denyRead` denies, `allowRead` re-allows/wins); write is deny-by-default (`allowWrite` allows, `denyWrite` denies/wins). Bare-basename globs (`*.pem`) match the basename anywhere; path globs match the full expanded path; literal paths match themselves or descendants (with a path boundary, not a string prefix). It runs in-process on every platform, unlike srt's macOS-only globs.
6. **Config merge is override, not concatenation.** `mergeConfig` replaces arrays when present; a project `sandbox.json` fully controls each list it specifies. Don't "extend" arrays on merge.
7. **No npm in nix.** The extension is dependency-free at runtime (pi provides its API; `srt` is a separate binary pinned via `PI_SANDBOX_SRT_BIN` or PATH). The flake only copies source — never add a build step or npm dependency to the nix package.

## Config & flags

- Policy merges from `<PI_CODING_AGENT_DIR>/sandbox.json` (global) then `<cwd>/.pi/sandbox.json` (project overrides global); both optional, falling back to `DEFAULT_CONFIG`.
- `pi --no-sandbox` disables sandboxing for the session; `/sandbox` prints the active policy.

## Conventions

- `just check` before declaring work done. Fix lint/format failures with `just fix`.
- Tests live in `test/*.test.ts` and cover the pure logic in `config.ts`/`fsguard.ts`/`policy.ts` — add tests when changing that logic. There are no integration tests for the pi wiring in `index.ts`/`srt.ts` by design.
- Keep file header comments accurate; they document each module's role and the no-pi-import invariant.
- This repo is also a jj/git repo (`.jj` exists) — be careful with `git`/`jj` commands that could rewrite history.
