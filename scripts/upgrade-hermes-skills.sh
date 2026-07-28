#!/usr/bin/env bash
set -euo pipefail

SOURCE_SKILLS_DIR="${1:-skills}"
TARGET_SKILLS_DIR="${2:-hermes-data/skills}"
SOURCE_SPECS_DIR="$(dirname "$SOURCE_SKILLS_DIR")/specs"
TARGET_SPECS_DIR="$(dirname "$TARGET_SKILLS_DIR")/specs"
SOURCE_INDEX="$SOURCE_SKILLS_DIR/index.json"
TARGET_INDEX="$TARGET_SKILLS_DIR/index.json"
REPLACEMENT_SKILL="video-render-runtime"
PREDECESSOR_SKILL="v""eo-video-runtime"
REQUIRED_SCHEMAS=(
  "video_job_contract_spec.v2.json"
  "video_runtime_state_schema.v2.json"
)

log() { printf '[aries-skill-upgrade] %s\n' "$*"; }
fail() { printf '[aries-skill-upgrade] ERROR: %s\n' "$*" >&2; exit 1; }

merge_managed_registry_entry() {
  local source_index="$1" target_index="$2" location closing_line closing_column has_entries temp_index
  grep -q '"name"[[:space:]]*:[[:space:]]*"video-render-runtime"' "$source_index" \
    || fail "managed skill registry entry is missing: $source_index"

  if [ ! -f "$target_index" ]; then
    cp "$source_index" "$target_index"
    return
  fi
  if grep -q '"name"[[:space:]]*:[[:space:]]*"video-render-runtime"' "$target_index"; then
    return
  fi

  # Locate the bracket that closes the named `skills` array instead of assuming
  # it is the last array in the document. This keeps unrelated operator-owned
  # registry arrays byte-for-byte intact without requiring host Node or jq.
  location="$(awk '
    {
      scan_from = 1
      if (!found_key) {
        if (!match($0, /"skills"[[:space:]]*:/)) next
        found_key = 1
        scan_from = RSTART + RLENGTH
      }
      if (!opened) {
        remainder = substr($0, scan_from)
        relative_open = index(remainder, "[")
        if (!relative_open) next
        opened = 1
        depth = 1
        scan_from += relative_open
      }

      in_string = 0
      escaped = 0
      for (column = scan_from; column <= length($0); column += 1) {
        character = substr($0, column, 1)
        if (in_string) {
          if (escaped) escaped = 0
          else if (character == "\\") escaped = 1
          else if (character == "\"") in_string = 0
          continue
        }
        if (character == "\"") {
          if (depth == 1) has_entries = 1
          in_string = 1
          continue
        }
        if (character == "[") {
          if (depth == 1) has_entries = 1
          depth += 1
          continue
        }
        if (character == "]") {
          depth -= 1
          if (depth == 0) {
            print NR, column, has_entries ? 1 : 0
            exit
          }
          continue
        }
        if (depth == 1 && character !~ /[[:space:],]/) has_entries = 1
      }
      scan_from = 1
    }
  ' "$target_index")"
  [ -n "$location" ] || fail "installed skill registry has no skills array: $target_index"
  read -r closing_line closing_column has_entries <<< "$location"
  temp_index="${target_index}.aries-upgrade.$$"
  awk -v closing_line="$closing_line" -v closing_column="$closing_column" -v has_entries="$has_entries" '
    NR == closing_line {
      prefix = substr($0, 1, closing_column - 1)
      suffix = substr($0, closing_column)
      indentation = prefix
      sub(/[^[:space:]].*$/, "", indentation)
      print prefix (has_entries ? "," : "")
      print "    {"
      print "      \"name\": \"video-render-runtime\","
      print "      \"category\": \"media-production\","
      print "      \"path\": \"skills/video-render-runtime/SKILL.md\","
      print "      \"owner\": \"aries\","
      print "      \"status\": \"active\","
      print "      \"last_updated\": \"2026-07-27\","
      print "      \"version\": \"2.0.0\","
      print "      \"visibility\": {"
      print "        \"scope\": \"all\","
      print "        \"agents\": []"
      print "      }"
      print "    }"
      print indentation suffix
      next
    }
    { print }
  ' "$target_index" > "$temp_index"
  mv "$temp_index" "$target_index"
}

SOURCE_DIR="$SOURCE_SKILLS_DIR/$REPLACEMENT_SKILL"
TARGET_DIR="$TARGET_SKILLS_DIR/$REPLACEMENT_SKILL"
PREDECESSOR_DIR="$TARGET_SKILLS_DIR/$PREDECESSOR_SKILL"
STAGING_DIR="$TARGET_SKILLS_DIR/.${REPLACEMENT_SKILL}.upgrade.$$"

[ -f "$SOURCE_DIR/SKILL.md" ] || fail "managed source skill is missing: $SOURCE_DIR/SKILL.md"
[ -f "$SOURCE_INDEX" ] || fail "managed skill registry is missing: $SOURCE_INDEX"
for schema in "${REQUIRED_SCHEMAS[@]}"; do
  [ -f "$SOURCE_SPECS_DIR/$schema" ] || fail "managed video schema is missing: $SOURCE_SPECS_DIR/$schema"
done
mkdir -p "$TARGET_SKILLS_DIR"
rm -rf "$STAGING_DIR"
trap 'rm -rf "$STAGING_DIR"' EXIT

cp -R "$SOURCE_DIR" "$STAGING_DIR"
printf '%s\n' 'managed-by=aries-app' 'skill=video-render-runtime' > "$STAGING_DIR/.aries-managed-skill"
mkdir -p "$TARGET_SPECS_DIR"
for schema in "${REQUIRED_SCHEMAS[@]}"; do
  cp "$SOURCE_SPECS_DIR/$schema" "$TARGET_SPECS_DIR/$schema"
done
merge_managed_registry_entry "$SOURCE_INDEX" "$TARGET_INDEX"

rm -rf "$TARGET_DIR"
mv "$STAGING_DIR" "$TARGET_DIR"
rm -rf "$PREDECESSOR_DIR"

trap - EXIT
log "installed $REPLACEMENT_SKILL and removed its retired predecessor if present"
