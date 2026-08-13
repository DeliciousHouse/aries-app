#!/usr/bin/env bash
# Pre-flight guard for manual `docker compose up` in the deploy checkout.
#
# Refuses (exit 1) when the ARIES_APP_IMAGE pin that compose would resolve
# disagrees with the image the running containers actually run. That mismatch
# is the failure operators actually hit: on 2026-08-12 a bare
# `docker compose up -d` in the deploy checkout silently recreated four
# production containers onto a stale pinned image, and later the same day the
# pin pointed at an image three production fixes behind the running
# containers. The Deploy workflow now rewrites the pin after every deploy
# (scripts/release/sync-env-image-pin.sh), but this guard is the belt to that
# suspender: run it before any manual compose up/restart so a stale or
# hand-edited pin is caught before it recreates anything.
#
# Usage (from the compose directory, e.g. /home/node/aries-app):
#   ./scripts/check-image-pin.sh                 # check every running app-image service
#   ./scripts/check-image-pin.sh aries-app       # check only the named service(s)
#
# Exit codes: 0 = pin matches everything running (or nothing is running);
#             1 = mismatch, or the check could not be completed safely.
set -euo pipefail

# Services that deliberately run their own pinned images, not ARIES_APP_IMAGE.
PIN_EXEMPT_SERVICES=("aries-autoheal" "aries-hermes")

resolve_pin() {
  # Mirror compose interpolation precedence: process environment beats .env,
  # which beats the compose-file default.
  if [[ -n "${ARIES_APP_IMAGE:-}" ]]; then
    printf '%s\n' "${ARIES_APP_IMAGE}"
    return 0
  fi
  if [[ -f .env ]]; then
    local line
    line="$(grep -E '^[[:space:]]*ARIES_APP_IMAGE=' .env | tail -n 1 || true)"
    if [[ -n "${line}" ]]; then
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line#ARIES_APP_IMAGE=}"
      line="${line%\"}"; line="${line#\"}"
      line="${line%\'}"; line="${line#\'}"
      if [[ -n "${line}" ]]; then
        printf '%s\n' "${line}"
        return 0
      fi
    fi
  fi
  printf 'aries-app:local\n'
}

is_exempt() {
  local service="$1" exempt
  for exempt in "${PIN_EXEMPT_SERVICES[@]}"; do
    [[ "${service}" == "${exempt}" ]] && return 0
  done
  return 1
}

pin="$(resolve_pin)"
pinned_image_id="$(docker image inspect -f '{{.Id}}' "${pin}" 2>/dev/null || true)"

services=("$@")
if [[ ${#services[@]} -eq 0 ]]; then
  # `docker compose ps --services` lists services with running containers.
  # Capture first so a docker/compose failure fails the guard instead of
  # reading as "nothing is running".
  if ! services_output="$(docker compose ps --services 2>/dev/null)"; then
    echo "ERROR: check-image-pin: unable to list compose services; run this from the compose directory." >&2
    exit 1
  fi
  mapfile -t services <<<"${services_output}"
fi

checked=0
mismatches=0
for service in "${services[@]}"; do
  [[ -n "${service}" ]] || continue
  if is_exempt "${service}"; then
    continue
  fi
  container_id="$(docker compose ps -q "${service}" 2>/dev/null || true)"
  if [[ -z "${container_id}" ]]; then
    continue
  fi
  running="$(docker inspect -f '{{.State.Running}}' "${container_id}" 2>/dev/null || echo false)"
  if [[ "${running}" != "true" ]]; then
    continue
  fi
  running_image_id="$(docker inspect -f '{{.Image}}' "${container_id}" 2>/dev/null || true)"
  running_image_ref="$(docker inspect -f '{{.Config.Image}}' "${container_id}" 2>/dev/null || true)"
  checked=$((checked + 1))
  if [[ -z "${running_image_id}" || -z "${pinned_image_id}" || "${running_image_id}" != "${pinned_image_id}" ]]; then
    if [[ -z "${pinned_image_id}" ]]; then
      echo "MISMATCH ${service}: pin ${pin} is not even pulled on this host, but the service is running ${running_image_ref} (${running_image_id})." >&2
    else
      echo "MISMATCH ${service}: running ${running_image_ref} (${running_image_id}) but the pin resolves to ${pin} (${pinned_image_id})." >&2
    fi
    mismatches=$((mismatches + 1))
  fi
done

if (( checked == 0 )); then
  echo "check-image-pin: no running app-image containers; 'docker compose up' would start ${pin} fresh."
  exit 0
fi

if (( mismatches != 0 )); then
  cat >&2 <<EOF
ERROR: the ARIES_APP_IMAGE pin does not describe what production is running.
A 'docker compose up' here would RECREATE the mismatched service(s) onto ${pin},
which is a silent rollback if the pin is stale (the usual case).

To fix the pin to match the running containers:
  ./scripts/release/sync-env-image-pin.sh .env <the image ref the last deploy used>
(The Deploy workflow logs it as TARGET_IMAGE; it also now rewrites the pin on
every successful deploy.)

To intentionally change what runs, use the Deploy workflow (gh workflow run
Deploy -f image_tag=<sha>) instead of a bare compose up — it applies schema,
quiesces publishing, and verifies health; compose up does none of that.
EOF
  exit 1
fi

echo "check-image-pin: OK — ${checked} running service(s) match the pin ${pin}."
