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

docker compose stop aries-scheduled-posts-worker

schema_status=0
PGOPTIONS="-c lock_timeout=5s -c statement_timeout=120s" \
  ARIES_APP_IMAGE="${TARGET_IMAGE}" \
  docker compose run --rm --no-deps --entrypoint node aries-app scripts/init-db.js || schema_status=$?
if [[ "${schema_status}" -ne 0 ]]; then
  echo "ERROR: target-image schema apply failed (exit ${schema_status}); restoring the exact pre-rollout scheduled worker container." >&2
  if [[ "${previous_scheduled_worker_was_running}" == "true" && -n "${previous_scheduled_worker_id}" ]]; then
    if ! docker start "${previous_scheduled_worker_id}" >/dev/null; then
      echo "ERROR: failed to restart pre-rollout worker ${previous_scheduled_worker_id}; manual recovery required." >&2
    elif [[ "$(docker inspect -f '{{.State.Running}}' "${previous_scheduled_worker_id}" 2>/dev/null || echo false)" != "true" ]]; then
      echo "ERROR: pre-rollout worker ${previous_scheduled_worker_id} did not remain running after restore." >&2
    fi
  fi
  exit "${schema_status}"
fi
