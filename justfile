# pi-agent — pi coding agent config and extensions
# Run `just` to list targets.

# Node 26 + pnpm 11 come from mise (.mise.toml).

_default:
    @just --list

# Install the toolchain (node/pnpm via mise) and JS deps.
install:
    mise install
    pnpm install

check: fmt-check lint typecheck test

# Run the unit tests.
test:
    pnpm run test

typecheck:
    tsgo --noEmit

lint:
    oxlint .

fix:
    oxfmt --write .
    oxlint --fix .
    nix fmt .

fmt-fix:

fmt-check:
    oxfmt --check .

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
