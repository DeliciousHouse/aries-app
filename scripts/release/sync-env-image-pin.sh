#!/usr/bin/env bash
# Sync the ARIES_APP_IMAGE pin in the deploy checkout's .env to the image the
# deploy just placed in production.
#
# Why this exists: docker-compose.yml resolves
# `image: ${ARIES_APP_IMAGE:-aries-app:local}` from the host .env whenever
# anyone runs a bare `docker compose up` in the deploy checkout. The Deploy
# workflow pins every one of its own compose invocations with an explicit
# `ARIES_APP_IMAGE="${TARGET_IMAGE}"` environment override, so the containers
# roll forward while the .env pin stays wherever the last writer left it. That
# stale pin silently rolled production back twice on 2026-08-12: a bare
# `docker compose up -d` recreated four containers onto an old image, and later
# the same day the pin pointed at an image three production fixes behind the
# running containers. Rewriting the pin at the end of each successful deploy
# makes the file describe what is actually running, so a later bare
# `docker compose up` converges instead of rolling back.
#
# Usage: sync-env-image-pin.sh <env-file> <image-ref>
#
# Behavior:
# - Replaces the first ARIES_APP_IMAGE= line in place; every other line
#   (other variables, comments, blank lines) is copied through byte-for-byte.
# - Appends the line when no ARIES_APP_IMAGE= line exists.
# - Collapses duplicate ARIES_APP_IMAGE= lines onto the single new pin.
# - Creates the file when it does not exist (compose would otherwise fall back
#   to the aries-app:local default, which is just a differently-stale pin).
# - Rewrites via a same-directory temp file + rename so a crash mid-write can
#   never leave a truncated .env, and preserves the file's permissions.
set -euo pipefail

ENV_FILE="${1:?usage: sync-env-image-pin.sh <env-file> <image-ref>}"
IMAGE_REF="${2:?usage: sync-env-image-pin.sh <env-file> <image-ref>}"

PIN_LINE="ARIES_APP_IMAGE=${IMAGE_REF}"

if [[ ! -e "${ENV_FILE}" ]]; then
  # The .env holds secrets in practice; create it owner-only rather than
  # inheriting the process umask.
  (umask 077; printf '%s\n' "${PIN_LINE}" > "${ENV_FILE}")
  echo "sync-env-image-pin: ${ENV_FILE} did not exist; created it with ${PIN_LINE}."
  exit 0
fi

if [[ ! -w "${ENV_FILE}" ]]; then
  echo "ERROR: sync-env-image-pin: ${ENV_FILE} exists but is not writable." >&2
  exit 1
fi

tmp_file="$(mktemp "${ENV_FILE}.sync.XXXXXX")"
trap 'rm -f "${tmp_file}"' EXIT

awk -v pin="${PIN_LINE}" '
  /^[[:space:]]*ARIES_APP_IMAGE=/ {
    if (!replaced) { print pin; replaced = 1 }
    next
  }
  { print }
  END { if (!replaced) print pin }
' "${ENV_FILE}" > "${tmp_file}"

# The .env holds secrets; keep whatever mode the operator set rather than the
# mktemp default. chown is best-effort (same-user deploys need no change).
chmod --reference="${ENV_FILE}" "${tmp_file}" 2>/dev/null || true
chown --reference="${ENV_FILE}" "${tmp_file}" 2>/dev/null || true

mv "${tmp_file}" "${ENV_FILE}"
trap - EXIT
echo "sync-env-image-pin: pinned ${PIN_LINE} in ${ENV_FILE}"
