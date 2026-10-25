#!/usr/bin/env bash
# Fixture tests for merge-settings.sh.
#
# Run directly:   JQ="$(command -v jq)" bash nix/merge-settings.test.sh
# Run in nix:     nix flake check   (checks.<system>.settings-merge)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MERGE_SCRIPT="${MERGE_SCRIPT:-$here/merge-settings.sh}"
export JQ="${JQ:-jq}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# run <name> <base> <extra> <user> <last> <expected-settings> <expected-state>
# All args are compact JSON. `last`/`expected-state` are package arrays.
run() {
  local name="$1" base="$2" extra="$3" user="$4" last="$5" expected="$6" state="$7"
  local dir="$tmp/$name"
  mkdir -p "$dir"
  printf '%s' "$base" > "$dir/base.json"
  printf '%s' "$extra" > "$dir/extra.json"
  printf '%s' "$user" > "$dir/settings.json"
  printf '%s' "$last" > "$dir/state.json"

  SETTINGS_FILE="$dir/settings.json" STATE_FILE="$dir/state.json" \
    BASE="$dir/base.json" EXTRA="$dir/extra.json" \
    bash "$MERGE_SCRIPT"

  local got want
  got=$(jq -cS '.' "$dir/settings.json")
  want=$(printf '%s' "$expected" | jq -cS '.')
  [ "$got" = "$want" ] || fail "$name: settings = $got, want $want"

  got=$(jq -c '.' "$dir/state.json")
  want=$(printf '%s' "$state" | jq -c '.')
  [ "$got" = "$want" ] || fail "$name: state = $got, want $want"

  echo "ok: $name"
}

# Locally installed packages survive a switch.
run local-packages-survive \
  '{"packages":["npm:ponytail"]}' '{}' \
  '{"packages":["npm:ponytail","npm:foo"],"defaultModel":"local"}' \
  '["npm:ponytail"]' \
  '{"packages":["npm:foo","npm:ponytail"],"defaultModel":"local"}' \
  '["npm:ponytail"]'

# Curated keys override on-disk keys; uncurated keys are preserved.
run curated-keys-win \
  '{"theme":"dark"}' '{}' \
  '{"theme":"light","defaultModel":"local"}' \
  '[]' \
  '{"theme":"dark","defaultModel":"local","packages":[]}' \
  '[]'

# A package dropped from the curated list is removed, not re-kept as local.
run dropped-package-removed \
  '{}' '{}' \
  '{"packages":["npm:ponytail"]}' \
  '["npm:ponytail"]' \
  '{"packages":[]}' \
  '[]'

# base and extra packages are unioned and deduped.
run base-and-extra-union \
  '{"packages":["npm:a","npm:b"]}' '{"packages":["npm:b","npm:c"]}' \
  '{"packages":["npm:a"]}' \
  '[]' \
  '{"packages":["npm:a","npm:b","npm:c"]}' \
  '["npm:a","npm:b","npm:c"]'

# cfg.settings packages count as curated, so they are not mistaken for local.
run extra-package-is-curated \
  '{}' '{"packages":["npm:bar"]}' \
  '{"packages":["npm:bar","npm:local"]}' \
  '["npm:bar"]' \
  '{"packages":["npm:bar","npm:local"]}' \
  '["npm:bar"]'

# Two switches in a row: the state written by the first must be readable by the
# second (catches a write/read format mismatch).
two_pass() {
  local dir="$tmp/two-pass"
  mkdir -p "$dir"
  printf '%s' '{"packages":["npm:ponytail"]}' > "$dir/base.json"
  printf '%s' '{}' > "$dir/extra.json"
  printf '%s' '{"packages":["npm:ponytail"]}' > "$dir/settings.json"

  SETTINGS_FILE="$dir/settings.json" STATE_FILE="$dir/state.json" \
    BASE="$dir/base.json" EXTRA="$dir/extra.json" bash "$MERGE_SCRIPT"

  # User installs another package via the pi TUI between switches.
  jq '.packages += ["npm:foo"]' "$dir/settings.json" > "$dir/settings.json.tmp"
  mv "$dir/settings.json.tmp" "$dir/settings.json"

  SETTINGS_FILE="$dir/settings.json" STATE_FILE="$dir/state.json" \
    BASE="$dir/base.json" EXTRA="$dir/extra.json" bash "$MERGE_SCRIPT"

  local got
  got=$(jq -cS '.packages' "$dir/settings.json")
  [ "$got" = '["npm:foo","npm:ponytail"]' ] || fail "two-pass: packages = $got"
  echo "ok: two-pass"
}
two_pass

# A dry run must not remove a symlinked settings file.
dry_run_keeps_symlink() {
  local dir="$tmp/dry-run"
  mkdir -p "$dir"
  printf '%s' '{}' > "$dir/base.json"
  printf '%s' '{}' > "$dir/extra.json"
  printf '%s' '{"x":1}' > "$dir/real.json"
  ln -s real.json "$dir/settings.json"

  SETTINGS_FILE="$dir/settings.json" STATE_FILE="$dir/state.json" \
    BASE="$dir/base.json" EXTRA="$dir/extra.json" DRY_RUN=1 \
    bash "$MERGE_SCRIPT"

  [ -L "$dir/settings.json" ] || fail "dry-run removed the settings symlink"
  [ "$(cat "$dir/real.json")" = '{"x":1}' ] || fail "dry-run changed the settings file"
  echo "ok: dry-run-keeps-symlink"
}
dry_run_keeps_symlink

echo "all merge-settings tests passed"
