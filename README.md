# pi-config

Configuration and extensions for the [pi](https://github.com/earendil-works/pi)
coding agent, managed as a real TypeScript project and consumed by my
[nix-config](../nix-config) via a flake input.

## Layout

```
pi/settings.json        # pi user settings (packages, etc.)
pi/sandbox.json         # default sandbox policy (global)
src/sandbox/            # the "sandbox" pi extension (loaded by pi via jiti, no build)
test/                   # Unit tests
flake.nix               # exposes packages.pi-config (assembled tree) to nix-config
```

## The sandbox extension

Sandboxes what the agent can do, layered:

- **bash / `user_bash`** run through a command policy at execution time:
  - `ssh` / `scp` / `sftp` / `rsync` → **blocked** (fixed policy).
  - `git`, `gh`, package managers, `nix`, `docker`/`kubectl` → **bypass** the OS
    sandbox (full fs + network), but only after a static deny-path scan.
  - everything else → run under [`srt`](https://github.com/anthropic-experimental/sandbox-runtime)
    (`sandbox-exec` on macOS, bubblewrap on Linux) with the network + filesystem
    policy from `sandbox.json`.
- **read / write / edit / find / ls / grep** are gated at the pi level against the
  same filesystem policy — defense in depth, since those tools run inside pi's
  process and never touch the OS sandbox.

Policy is merged from `<PI_CODING_AGENT_DIR>/sandbox.json` (global) and
`<project>/.pi/sandbox.json` (project-local overrides global). `pi --no-sandbox`
disables it; `/sandbox` prints the active policy.

## Toolchain

Node 26 + pnpm 11 via [mise](https://mise.jdx.dev) (`mise.toml`). TypeScript 7
(`tsgo`) for typechecking, `oxlint`/`oxfmt` for lint/format, `node:test` for tests.

```sh
mise install       # node 26 + pnpm 11
pnpm install
pnpm check         # typecheck + lint + test
```

## Nix

The extension is dependency-free at runtime (pi provides its own API; `srt` is a
separate binary), so nix just vendors the source — no npm in nix. `nix-config`
adds this repo as a flake input and symlinks `packages.pi-config` into
`~/.config/pi`.
