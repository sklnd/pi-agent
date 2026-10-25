#!/usr/bin/env bash
# Merge curated pi settings into the on-disk settings.json.
#
# Curated keys win, except `packages`: it is the union of the curated set and
# packages installed locally via pi (current packages minus those curated on the
# previous run, recorded in STATE_FILE). Tracking the previous curated set is
# what lets a package removed from the curated list actually disappear.
#
# Env:
#   SETTINGS_FILE  mutable settings.json (created if missing)
#   STATE_FILE     records the curated packages from the previous run
#   BASE           curated pi/settings.json
#   EXTRA          generated cfg.settings JSON (use {} when empty)
#   JQ             jq binary (default: jq on PATH)
#   DRY_RUN_CMD    prefix for mutating commands (empty for real runs)
#   DRY_RUN        when non-empty, only report and exit
set -euo pipefail

jq="${JQ:-jq}"
run="${DRY_RUN_CMD:-}"

$run mkdir -p "$(dirname "$SETTINGS_FILE")"

userJson=$("$jq" -c '.' "$SETTINGS_FILE" 2>/dev/null || echo '{}')
lastCurated=$("$jq" -c '.' "$STATE_FILE" 2>/dev/null || echo '[]')

# Migrate away from a read-only store symlink (EPERM on save).
if [ -L "$SETTINGS_FILE" ]; then
  $run rm -f "$SETTINGS_FILE"
fi

if [ -n "${DRY_RUN:-}" ]; then
  echo "(dry-run) merge $BASE into $SETTINGS_FILE"
  exit 0
fi

merged=$(printf '%s' "$userJson" | "$jq" \
  --slurpfile base "$BASE" \
  --slurpfile extra "$EXTRA" \
  --argjson last "$lastCurated" '
    . as $user
    | ($base[0]) as $b
    | ($extra[0]) as $e
    | ([($b.packages // [])[], ($e.packages // [])[]] | unique) as $curated
    | (($user.packages // []) - $last) as $local
    | ($user * $b * $e)
    | .packages = (($curated + $local) | unique)
  ')
printf '%s\n' "$merged" > "$SETTINGS_FILE.tmp"
mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"

"$jq" -c -s '[.[].packages[]?] | unique' "$BASE" "$EXTRA" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
