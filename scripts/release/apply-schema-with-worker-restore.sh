#!/usr/bin/env bash
set -euo pipefail

: "${TARGET_IMAGE:?TARGET_IMAGE is required}"

previous_scheduled_worker_id="$(docker compose ps -q aries-scheduled-posts-worker)"
previous_scheduled_worker_was_running=false
if [[ -n "${previous_scheduled_worker_id}" ]]; then
  previous_scheduled_worker_was_running="$(
    docker inspect -f '{{.State.Running}}' "${previous_scheduled_worker_id}" 2>/dev/null || echo false
  )"
fi

scheduled_worker_cutover_complete=false

restore_previous_scheduled_worker_on_exit() {
  local original_status=$?
  trap - EXIT
  if [[ "${scheduled_worker_cutover_complete}" != "true" \
        && "${previous_scheduled_worker_was_running}" == "true" \
        && -n "${previous_scheduled_worker_id}" ]]; then
    echo "ERROR: deploy failed before the replacement scheduled worker was running; restoring exact pre-rollout container ${previous_scheduled_worker_id}." >&2
    if ! docker start "${previous_scheduled_worker_id}" >/dev/null; then
      echo "ERROR: failed to restart pre-rollout worker ${previous_scheduled_worker_id}; manual recovery required." >&2
    elif [[ "$(docker inspect -f '{{.State.Running}}' "${previous_scheduled_worker_id}" 2>/dev/null || echo false)" != "true" ]]; then
      echo "ERROR: pre-rollout worker ${previous_scheduled_worker_id} did not remain running after restore." >&2
    fi
  fi
  return "${original_status}"
}

complete_scheduled_worker_cutover() {
  scheduled_worker_cutover_complete=true
  trap - EXIT
}

# This script is sourced by deploy.yml so the EXIT trap spans schema apply,
# app recreate, identity checks, and health verification. The caller disarms it
# immediately before Compose starts replacing the old worker container.
trap restore_previous_scheduled_worker_on_exit EXIT

docker compose stop aries-scheduled-posts-worker

PGOPTIONS="-c lock_timeout=5s -c statement_timeout=120s" \
  ARIES_APP_IMAGE="${TARGET_IMAGE}" \
  timeout --signal=TERM 180s \
  docker compose run --rm --no-deps --entrypoint node aries-app scripts/init-db.js

# Direct execution remains useful for the schema-only smoke test. The real
# deploy sources this file and calls complete_scheduled_worker_cutover only after
# every app gate has passed and immediately before worker replacement begins.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  complete_scheduled_worker_cutover
fi
