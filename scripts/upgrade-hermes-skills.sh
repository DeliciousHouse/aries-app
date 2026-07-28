#!/usr/bin/env bash
set -euo pipefail

SOURCE_SKILLS_DIR="${1:-skills}"
TARGET_SKILLS_DIR="${2:-hermes-data/skills}"
REPLACEMENT_SKILL="video-render-runtime"
PREDECESSOR_SKILL="v""eo-video-runtime"

log() { printf '[aries-skill-upgrade] %s\n' "$*"; }
fail() { printf '[aries-skill-upgrade] ERROR: %s\n' "$*" >&2; exit 1; }

SOURCE_DIR="$SOURCE_SKILLS_DIR/$REPLACEMENT_SKILL"
TARGET_DIR="$TARGET_SKILLS_DIR/$REPLACEMENT_SKILL"
PREDECESSOR_DIR="$TARGET_SKILLS_DIR/$PREDECESSOR_SKILL"
STAGING_DIR="$TARGET_SKILLS_DIR/.${REPLACEMENT_SKILL}.upgrade.$$"

[ -f "$SOURCE_DIR/SKILL.md" ] || fail "managed source skill is missing: $SOURCE_DIR/SKILL.md"
mkdir -p "$TARGET_SKILLS_DIR"
rm -rf "$STAGING_DIR"
trap 'rm -rf "$STAGING_DIR"' EXIT

cp -R "$SOURCE_DIR" "$STAGING_DIR"
printf '%s\n' 'managed-by=aries-app' 'skill=video-render-runtime' > "$STAGING_DIR/.aries-managed-skill"

rm -rf "$TARGET_DIR"
mv "$STAGING_DIR" "$TARGET_DIR"
rm -rf "$PREDECESSOR_DIR"

trap - EXIT
log "installed $REPLACEMENT_SKILL and removed its retired predecessor if present"
