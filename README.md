# pi-agent

Configuration and extensions for the [pi](https://github.com/earendil-works/pi) coding agent. It is consumed as a nix flake by my [nix-config](../nix-config).

This provides an opinionated configuration for my pi setup, with the extensions I find essential. It includes a `sandbox` extension that places guardrails on system access.

## Layout

```
pi/settings.json   # pi user settings (packages)
src/sandbox/       # the "sandbox" extension
test/              # unit tests for the pure modules
nix/               # home-manager module, settings-merge script and test
flake.nix          # packages.pi-config (assembled config tree), checks, home-manager module
```

## What the sandbox does

The extension uses [`srt`](https://github.com/anthropic-experimental/sandbox-runtime) for OS-level sandboxing (`sandbox-exec` on macOS, bubblewrap on Linux). Pi's own file tools never reach `srt`, so the extension enforces the filesystem policy for them directly.

### Filesystem policy

The policy explicitly denies or allows filesystem operations. `srt` enforces it for sandboxed commands. Trusted tools that bypass the sandbox are only checked by a best-effort deny-path scan. File tools are checked by the extension. If `srt` is missing, sandboxed commands are refused rather than run unsandboxed.

### Bash commands

Commands are filtered by a policy at execution time:

- Network file-transfer and remote-shell tools are blocked: `ssh`, `scp`, `sftp`, `rsync`.
- Trusted tools run outside the sandbox if they pass a deny-path scan: `jj`, `git`, `gh`, package managers, `docker`, `kubectl`, `mise`. Forms that turn a trusted tool into an arbitrary command runner are blocked.
- Everything else runs under `srt`.

A command pipeline where any segment is untrusted is fully sandboxed. Command `srt` bypass requires every segment to be trusted.

### File tools

File tools (`read`, `write`, `edit`, `find`, `ls`, `grep`) are checked in the extension against the same filesystem policy. They run in pi's own process, so `srt` cannot enforce filesystem controls for them.

## Configuring

The default policy is `DEFAULT_CONFIG` in `src/sandbox/config.ts`. A project can override it with `<project>/.pi/sandbox.json`. Any list the file specifies replaces the default list rather than extending it. On macOS and Linux, sandboxing is always on. `/sandbox` prints the active policy.

## Development

This project uses Node 26 and pnpm 12 via [mise](https://mise.jdx.dev).

`just` is the task runner.

### Just targets

```sh
just install    # mise install + pnpm install
just check-js   # format, lint, typecheck, tests (runs in the pi sandbox)
just check      # the above plus Nix linting and flake checks (needs the nix daemon)
just fix        # format and fix lint issues
```

`just` lists all targets.

### Tooling

- TypeScript: type checking
- treefmt: formatting
- oxlint: TypeScript linting
- oxfmt: TypeScript formatting
- alejandra: Nix formatting
- statix: Nix linting
- deadnix: Nix linting

## Nix

The extension has no npm dependencies: pi provides the API and `srt` is a separate binary. So the flake only copies source and nothing goes through npm.

It exposes three things:

- `packages.pi-config`: the `$PI_CODING_AGENT_DIR` tree, which contains `settings.json` and `extensions/sandbox/*.ts`.
- `packages.pi` and `packages.srt`: passthroughs from [llm-agents.nix](https://github.com/numtide/llm-agents.nix).
- `homeManagerModules.default`: the home-manager module, described below.

### Home-manager module

`homeManagerModules.default` installs pi and srt, sets the environment variables, and symlinks the extension. On activation it merges `pi/settings.json` into the mutable `~/.config/pi/settings.json`. Curated settings keys win. The exception is `packages`, which is unioned so locally installed pi extensions survive a switch.
