# pi-agent — pi coding agent config and extensions
# Run `just` to list targets.

# Node 26 + pnpm 11 come from mise (.mise.toml).

_default:
    @just --list

# Install the toolchain (node/pnpm via mise) and JS deps.
install:
    mise install
    pnpm install

# Full check: JS + nix.
check: check-js check-nix

# JS checks, sandbox-safe.
check-js: fmt-check lint-js typecheck test-js

check-nix: lint-nix test-nix

# Run all linters.
lint: lint-js lint-nix

# Run all tests.
test: test-js test-nix

test-js:
    pnpm run test

test-nix:
    nix flake check

typecheck:
    tsc --noEmit

lint-js:
    oxlint .

lint-nix:
    statix check .
    deadnix --fail .

fix:
    treefmt
    oxlint --fix .

fmt-check:
    treefmt --fail-on-change

# Build the nix package (assembled pi config tree) that nix-config consumes.
build:
    nix build .#pi-config

# Show what the built config tree contains.
show: build
    find "$(nix build .#pi-config --no-link --print-out-paths)" -type f

# Update the flake's nixpkgs input.
update:
    nix flake update

# Remove build/dep artifacts.
clean:
    rm -rf node_modules result
