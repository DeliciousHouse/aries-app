#!/usr/bin/env bash
set -euo pipefail

: "${TARGET_IMAGE:?TARGET_IMAGE is required}"

scheduled_worker_service="aries-scheduled-posts-worker"
helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
previous_scheduled_worker_id="$(docker compose ps -q "${scheduled_worker_service}")"
previous_scheduled_worker_was_running=false
previous_scheduled_worker_image_id=""
if [[ -n "${previous_scheduled_worker_id}" ]]; then
  previous_scheduled_worker_was_running="$(
    docker inspect -f '{{.State.Running}}' "${previous_scheduled_worker_id}" 2>/dev/null || echo false
  )"
  previous_scheduled_worker_image_id="$(
    docker inspect -f '{{.Image}}' "${previous_scheduled_worker_id}" 2>/dev/null || true
  )"
fi

scheduled_worker_cutover_complete=false
previous_scheduled_worker_snapshot=""

cleanup_scheduled_worker_snapshot() {
  if [[ -n "${previous_scheduled_worker_snapshot}" ]]; then
    rm -f "${previous_scheduled_worker_snapshot}"
    previous_scheduled_worker_snapshot=""
  fi
}

restore_container_from_snapshot() {
  local snapshot_path=$1
  if [[ -n "${RESTORE_CONTAINER_COMMAND:-}" ]]; then
    "${RESTORE_CONTAINER_COMMAND}" "${snapshot_path}"
  else
    node "${helper_dir}/restore-container-from-inspect.mjs" "${snapshot_path}"
  fi
}

restore_previous_scheduled_worker_on_exit() {
  local original_status=$?
  trap - EXIT
  set +e

  if [[ "${scheduled_worker_cutover_complete}" != "true" \
        && "${previous_scheduled_worker_was_running}" == "true" \
        && -n "${previous_scheduled_worker_id}" ]]; then
    echo "ERROR: scheduled-worker cutover failed; restoring exact pre-rollout worker state." >&2

    local current_worker_id
    current_worker_id="$(
      ARIES_APP_IMAGE="${TARGET_IMAGE}" docker compose ps -aq "${scheduled_worker_service}" 2>/dev/null
    )"
    if [[ -n "${current_worker_id}" && "${current_worker_id}" != "${previous_scheduled_worker_id}" ]]; then
      if ! docker rm -f "${current_worker_id}" >/dev/null; then
        echo "ERROR: could not remove failed replacement worker ${current_worker_id}; manual recovery required." >&2
        cleanup_scheduled_worker_snapshot
        return "${original_status}"
      fi
    fi

    local restore_id="${previous_scheduled_worker_id}"
    if ! docker inspect "${previous_scheduled_worker_id}" >/dev/null 2>&1; then
      if [[ -z "${previous_scheduled_worker_snapshot}" || ! -s "${previous_scheduled_worker_snapshot}" ]]; then
        echo "ERROR: pre-rollout worker was destroyed and no exact snapshot is available; manual recovery required." >&2
        cleanup_scheduled_worker_snapshot
        return "${original_status}"
      fi
      restore_id="$(restore_container_from_snapshot "${previous_scheduled_worker_snapshot}")"
      if [[ -z "${restore_id}" ]]; then
        echo "ERROR: exact pre-rollout worker recreation returned no container id; manual recovery required." >&2
        cleanup_scheduled_worker_snapshot
        return "${original_status}"
      fi
    fi

    if ! docker start "${restore_id}" >/dev/null; then
      echo "ERROR: failed to start restored pre-rollout worker ${restore_id}; manual recovery required." >&2
    else
      local restored_running restored_image_id
      restored_running="$(docker inspect -f '{{.State.Running}}' "${restore_id}" 2>/dev/null || echo false)"
      restored_image_id="$(docker inspect -f '{{.Image}}' "${restore_id}" 2>/dev/null || true)"
      if [[ "${restored_running}" != "true" \
            || -z "${previous_scheduled_worker_image_id}" \
            || "${restored_image_id}" != "${previous_scheduled_worker_image_id}" ]]; then
        echo "ERROR: restored worker verification failed (running=${restored_running}, image=${restored_image_id}); manual recovery required." >&2
      else
        echo "Restored exact pre-rollout scheduled worker ${restore_id}." >&2
      fi
    fi
  fi

  cleanup_scheduled_worker_snapshot
  return "${original_status}"
}

complete_scheduled_worker_cutover() {
  scheduled_worker_cutover_complete=true
  cleanup_scheduled_worker_snapshot
  trap - EXIT
}

prepare_scheduled_worker_replacement() {
  if [[ "${previous_scheduled_worker_was_running}" != "true" \
        || -z "${previous_scheduled_worker_id}" ]]; then
    return 0
  fi
  previous_scheduled_worker_snapshot="$(mktemp)"
  if ! docker inspect "${previous_scheduled_worker_id}" > "${previous_scheduled_worker_snapshot}"; then
    echo "ERROR: could not snapshot the exact pre-rollout scheduled worker." >&2
    return 1
  fi
  if [[ ! -s "${previous_scheduled_worker_snapshot}" ]]; then
    echo "ERROR: pre-rollout scheduled worker snapshot is empty." >&2
    return 1
  fi
}

replace_scheduled_worker_and_verify() {
  local target_image=$1
  local target_image_id=$2
  local replacement_id replacement_running replacement_image_id manifest_json manifest_image

  prepare_scheduled_worker_replacement

  if ! ARIES_APP_IMAGE="${target_image}" docker compose up -d --no-deps --force-recreate --pull always "${scheduled_worker_service}"; then
    echo "ERROR: replacement scheduled worker recreate failed." >&2
    return 1
  fi

  if ! replacement_id="$(ARIES_APP_IMAGE="${target_image}" docker compose ps -q "${scheduled_worker_service}")" \
      || [[ -z "${replacement_id}" ]]; then
    echo "ERROR: Compose did not return the replacement scheduled worker id." >&2
    return 1
  fi
  if ! replacement_running="$(docker inspect -f '{{.State.Running}}' "${replacement_id}")"; then
    echo "ERROR: replacement scheduled worker inspect failed." >&2
    return 1
  fi
  if [[ "${replacement_running}" != "true" ]]; then
    echo "ERROR: replacement scheduled worker is not running." >&2
    return 1
  fi
  if ! replacement_image_id="$(docker inspect -f '{{.Image}}' "${replacement_id}")"; then
    echo "ERROR: replacement scheduled worker image inspection failed." >&2
    return 1
  fi
  if [[ "${replacement_image_id}" != "${target_image_id}" ]]; then
    echo "ERROR: replacement scheduled worker image ${replacement_image_id} does not match ${target_image_id}." >&2
    return 1
  fi
  if ! manifest_json="$(ARIES_APP_IMAGE="${target_image}" docker compose config --format json)"; then
    echo "ERROR: replacement scheduled worker manifest inspection failed." >&2
    return 1
  fi
  if ! manifest_image="$(
    printf '%s' "${manifest_json}" | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const image = JSON.parse(input)?.services?.["aries-scheduled-posts-worker"]?.image;
        if (typeof image !== "string" || image.length === 0) process.exit(1);
        process.stdout.write(image);
      });
    '
  )"; then
    echo "ERROR: replacement scheduled worker manifest is missing its image." >&2
    return 1
  fi
  if [[ "${manifest_image}" != "${target_image}" ]]; then
    echo "ERROR: scheduled worker manifest image ${manifest_image} does not match ${target_image}." >&2
    return 1
  fi

  complete_scheduled_worker_cutover
  echo "Replacement scheduled worker ${replacement_id} is running on ${target_image_id}."
}

# This script is sourced by deploy.yml so the EXIT trap spans additive schema,
# compatible-app replacement, data cutover, and every worker replacement gate.
trap restore_previous_scheduled_worker_on_exit EXIT

docker compose stop "${scheduled_worker_service}"

PGOPTIONS="-c lock_timeout=5s -c statement_timeout=120s" \
  ARIES_APP_IMAGE="${TARGET_IMAGE}" \
  timeout --signal=TERM 180s \
  docker compose run --rm --no-deps --entrypoint node aries-app scripts/init-db.js

# Direct execution is a schema-only smoke path. It must restore the exact old
# worker on success too; only a sourced full deploy replaces and verifies it.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${previous_scheduled_worker_was_running}" == "true" \
        && -n "${previous_scheduled_worker_id}" ]]; then
    docker start "${previous_scheduled_worker_id}" >/dev/null
    direct_running="$(docker inspect -f '{{.State.Running}}' "${previous_scheduled_worker_id}")"
    direct_image_id="$(docker inspect -f '{{.Image}}' "${previous_scheduled_worker_id}")"
    if [[ "${direct_running}" != "true" \
          || "${direct_image_id}" != "${previous_scheduled_worker_image_id}" ]]; then
      echo "ERROR: schema-only worker restore verification failed." >&2
      exit 1
    fi
  fi
  complete_scheduled_worker_cutover
fi
