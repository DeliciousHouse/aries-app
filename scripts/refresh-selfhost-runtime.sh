#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${1:?source snapshot directory is required}"
TARGET_ROOT="${2:?existing self-host directory is required}"

log() { printf '[aries-selfhost-refresh] %s\n' "$*"; }
fail() { printf '[aries-selfhost-refresh] ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$SOURCE_ROOT" ] || fail "source snapshot does not exist: $SOURCE_ROOT"
[ -f "$SOURCE_ROOT/docker-compose.selfhost.yml" ] || fail "source snapshot is not an Aries checkout: $SOURCE_ROOT"
[ -d "$TARGET_ROOT" ] || fail "target install does not exist: $TARGET_ROOT"
[ -f "$TARGET_ROOT/docker-compose.selfhost.yml" ] || fail "target is not an Aries self-host install: $TARGET_ROOT"

SOURCE_ROOT="$(cd "$SOURCE_ROOT" && pwd)"
TARGET_ROOT="$(cd "$TARGET_ROOT" && pwd)"
[ "$SOURCE_ROOT" != "$TARGET_ROOT" ] || fail "source snapshot and target install must be different directories"

# Repository-owned top-level entries are replaced from the fresh snapshot so
# stale files inside managed directories disappear. Operator-owned runtime
# state is deliberately excluded and remains byte-for-byte untouched.
shopt -s dotglob nullglob
for source_entry in "$SOURCE_ROOT"/*; do
  entry_name="$(basename "$source_entry")"
  case "$entry_name" in
    .git|.env|config.yaml|jobs|data|hermes-data|node_modules|.next|coverage|test-results)
      continue
      ;;
  esac
  target_entry="$TARGET_ROOT/$entry_name"
  rm -rf -- "$target_entry"
  cp -a -- "$source_entry" "$target_entry"
done

log "refreshed repository-managed runtime files while preserving operator state"
