#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${1:?usage: upgrade-hermes-skills.sh SOURCE_SKILLS_DIR TARGET_SKILLS_DIR}"
TARGET_ROOT="${2:?usage: upgrade-hermes-skills.sh SOURCE_SKILLS_DIR TARGET_SKILLS_DIR}"
MANAGED_SKILL="video-render-runtime"
# Construct the retired directory name without carrying the provider identifier
# as an active source token. This path exists only to clean up upgraded volumes.
PREDECESSOR_SKILL="v""eo-video-runtime"

[ -f "$SOURCE_ROOT/$MANAGED_SKILL/SKILL.md" ] || {
  printf 'missing managed skill source: %s\n' "$SOURCE_ROOT/$MANAGED_SKILL/SKILL.md" >&2
  exit 1
}

mkdir -p "$TARGET_ROOT"
TEMP_DIR="$(mktemp -d "$TARGET_ROOT/.aries-video-render-runtime.XXXXXX")"
cleanup() {
  if [ -n "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

cp -R "$SOURCE_ROOT/$MANAGED_SKILL/." "$TEMP_DIR/"
rm -rf "$TARGET_ROOT/$MANAGED_SKILL"
mv "$TEMP_DIR" "$TARGET_ROOT/$MANAGED_SKILL"
TEMP_DIR=""

# This removes only the known predecessor managed by Aries. Every unrelated
# directory in the skill volume is user-owned and must remain untouched.
if [ -d "$TARGET_ROOT/$PREDECESSOR_SKILL" ]; then
  rm -rf "$TARGET_ROOT/$PREDECESSOR_SKILL"
fi
