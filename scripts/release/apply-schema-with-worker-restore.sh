#!/usr/bin/env bash
set -euo pipefail

: "${TARGET_IMAGE:?TARGET_IMAGE is required}"

scheduled_worker_service="aries-scheduled-posts-worker"
application_service="${SERVICE_NAME:-aries-app}"
quiesce_application_during_schema="${ARIES_QUIESCE_APPLICATION_DURING_SCHEMA:-0}"
helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
previous_scheduled_worker_id=""
previous_scheduled_worker_was_running=false
previous_scheduled_worker_image_id=""
previous_scheduled_worker_snapshot=""
previous_application_id=""
previous_application_was_running=false
previous_application_image_id=""
previous_application_snapshot=""

if [[ "${quiesce_application_during_schema}" != "0" \
      && "${quiesce_application_during_schema}" != "1" ]]; then
  echo "ERROR: ARIES_QUIESCE_APPLICATION_DURING_SCHEMA must be 0 or 1." >&2
  exit 1
fi

if ! previous_scheduled_worker_id="$(docker compose ps -q "${scheduled_worker_service}")"; then
  echo "ERROR: could not identify the pre-rollout worker snapshot target." >&2
  exit 1
fi
if [[ -n "${previous_scheduled_worker_id}" ]]; then
  if ! previous_scheduled_worker_was_running="$(docker inspect -f '{{.State.Running}}' "${previous_scheduled_worker_id}")"; then
    echo "ERROR: could not verify the pre-rollout worker snapshot running state." >&2
    exit 1
  fi
  if ! previous_scheduled_worker_image_id="$(docker inspect -f '{{.Image}}' "${previous_scheduled_worker_id}")" \
      || [[ -z "${previous_scheduled_worker_image_id}" ]]; then
    echo "ERROR: could not verify the pre-rollout worker snapshot image." >&2
    exit 1
  fi

  previous_scheduled_worker_snapshot="$(mktemp)"
  if ! docker inspect "${previous_scheduled_worker_id}" > "${previous_scheduled_worker_snapshot}" \
      || [[ ! -s "${previous_scheduled_worker_snapshot}" ]]; then
    rm -f "${previous_scheduled_worker_snapshot}"
    previous_scheduled_worker_snapshot=""
    echo "ERROR: could not capture the exact pre-rollout worker snapshot." >&2
    exit 1
  fi
fi

if [[ "${quiesce_application_during_schema}" == "1" ]]; then
  if ! previous_application_id="$(docker compose ps -q "${application_service}")"; then
    echo "ERROR: could not identify the pre-rollout application quiesce target." >&2
    exit 1
  fi
  if [[ -n "${previous_application_id}" ]]; then
    if ! previous_application_was_running="$(docker inspect -f '{{.State.Running}}' "${previous_application_id}")"; then
      echo "ERROR: could not verify the pre-rollout application running state." >&2
      exit 1
    fi
    if ! previous_application_image_id="$(docker inspect -f '{{.Image}}' "${previous_application_id}")" \
        || [[ -z "${previous_application_image_id}" ]]; then
      echo "ERROR: could not verify the pre-rollout application image." >&2
      exit 1
    fi

    previous_application_snapshot="$(mktemp)"
    if ! docker inspect "${previous_application_id}" > "${previous_application_snapshot}" \
        || [[ ! -s "${previous_application_snapshot}" ]]; then
      rm -f "${previous_application_snapshot}"
      previous_application_snapshot=""
      echo "ERROR: could not capture the exact pre-rollout application snapshot." >&2
      exit 1
    fi
  fi
fi

scheduled_worker_cutover_complete=false
scheduled_worker_protocol_boundary_crossed=false
scheduled_worker_rollout_started=false
pre_boundary_restore_proven_safe=true
if [[ "${previous_scheduled_worker_was_running}" == "true" \
      || ( "${quiesce_application_during_schema}" == "1" \
           && "${previous_application_was_running}" == "true" ) ]]; then
  pre_boundary_restore_proven_safe=false
fi

cleanup_scheduled_worker_snapshot() {
  if [[ -n "${previous_scheduled_worker_snapshot}" ]]; then
    rm -f "${previous_scheduled_worker_snapshot}"
    previous_scheduled_worker_snapshot=""
  fi
}

cleanup_application_snapshot() {
  if [[ -n "${previous_application_snapshot}" ]]; then
    rm -f "${previous_application_snapshot}"
    previous_application_snapshot=""
  fi
}

restore_container_from_snapshot() {
  local snapshot_path=$1
  local node_snapshot_path="${snapshot_path}"
  local helper_path="${helper_dir}/restore-container-from-inspect.mjs"
  if command -v cygpath >/dev/null 2>&1; then
    node_snapshot_path="$(cygpath -w "${snapshot_path}")"
    helper_path="$(cygpath -w "${helper_path}")"
  fi
  if [[ -n "${RESTORE_CONTAINER_COMMAND:-}" ]]; then
    "${RESTORE_CONTAINER_COMMAND}" "${snapshot_path}"
  else
    node "${helper_path}" "${node_snapshot_path}"
  fi
}

verify_container_matches_snapshot() {
  local snapshot_path=$1
  local container_id=$2
  local node_snapshot_path="${snapshot_path}"
  local helper_path="${helper_dir}/restore-container-from-inspect.mjs"
  if command -v cygpath >/dev/null 2>&1; then
    node_snapshot_path="$(cygpath -w "${snapshot_path}")"
    helper_path="$(cygpath -w "${helper_path}")"
  fi
  if [[ -n "${RESTORE_CONTAINER_VERIFY_COMMAND:-}" ]]; then
    "${RESTORE_CONTAINER_VERIFY_COMMAND}" "${snapshot_path}" "${container_id}"
  else
    docker inspect "${container_id}" \
      | node "${helper_path}" --verify "${node_snapshot_path}"
  fi
}

wait_for_restored_application_readiness() {
  local container_id=$1
  local attempts="${ARIES_RESTORED_APPLICATION_READINESS_ATTEMPTS:-30}"
  local sleep_seconds="${ARIES_RESTORED_APPLICATION_READINESS_SLEEP_SECONDS:-5}"
  local probe_timeout_seconds="${ARIES_RESTORED_APPLICATION_READINESS_PROBE_TIMEOUT_SECONDS:-5}"
  local attempt health_status

  if ! [[ "${attempts}" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: ARIES_RESTORED_APPLICATION_READINESS_ATTEMPTS must be a positive integer." >&2
    return 1
  fi
  if ! [[ "${sleep_seconds}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: ARIES_RESTORED_APPLICATION_READINESS_SLEEP_SECONDS must be a non-negative integer." >&2
    return 1
  fi
  if ! [[ "${probe_timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: ARIES_RESTORED_APPLICATION_READINESS_PROBE_TIMEOUT_SECONDS must be a positive integer." >&2
    return 1
  fi

  for attempt in $(seq 1 "${attempts}"); do
    health_status="$(
      docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "${container_id}" 2>/dev/null || echo unknown
    )"
    if [[ "${health_status}" != "unhealthy" ]] \
        && docker exec "${container_id}" wget -qO- --timeout="${probe_timeout_seconds}" --tries=1 \
          "http://127.0.0.1:${PORT:-3000}/" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "${attempt}" -lt "${attempts}" ]]; then
      sleep "${sleep_seconds}"
    fi
  done

  echo "ERROR: restored application readiness failed after ${attempts} attempts; publishing remains stopped." >&2
  return 1
}

restore_previous_application_if_safe() {
  if [[ "${scheduled_worker_cutover_complete}" == "true" \
        || "${quiesce_application_during_schema}" != "1" \
        || "${previous_application_was_running}" != "true" \
        || -z "${previous_application_id}" ]]; then
    return 0
  fi
  if [[ "${scheduled_worker_protocol_boundary_crossed}" == "true" ]]; then
    echo "ERROR: scheduled-worker protocol boundary crossed; refusing to restore the pre-fence application. Only the compatible app may accept traffic." >&2
    return 0
  fi
  if [[ "${pre_boundary_restore_proven_safe}" != "true" ]]; then
    echo "ERROR: refusing to restore the previous application because unresolved pre-boundary provider claims may exist. Mutation traffic remains quiesced." >&2
    ARIES_APP_IMAGE="${TARGET_IMAGE}" docker compose stop "${application_service}" >/dev/null || true
    return 1
  fi

  local restore_id="${previous_application_id}"
  if ! docker inspect "${previous_application_id}" >/dev/null 2>&1; then
    if [[ -z "${previous_application_snapshot}" || ! -s "${previous_application_snapshot}" ]]; then
      echo "ERROR: pre-rollout application was destroyed and no exact snapshot is available; manual recovery required." >&2
      return 1
    fi
    restore_id="$(restore_container_from_snapshot "${previous_application_snapshot}")"
    if [[ -z "${restore_id}" ]]; then
      echo "ERROR: exact pre-rollout application recreation returned no container id; manual recovery required." >&2
      return 1
    fi
  fi

  if ! docker start "${restore_id}" >/dev/null; then
    echo "ERROR: failed to start restored pre-rollout application ${restore_id}; manual recovery required." >&2
    return 1
  fi
  local restored_running restored_image_id
  restored_running="$(docker inspect -f '{{.State.Running}}' "${restore_id}" 2>/dev/null || echo false)"
  restored_image_id="$(docker inspect -f '{{.Image}}' "${restore_id}" 2>/dev/null || true)"
  if [[ "${restored_running}" != "true" \
        || -z "${previous_application_image_id}" \
        || "${restored_image_id}" != "${previous_application_image_id}" ]]; then
    echo "ERROR: restored application verification failed (running=${restored_running}, image=${restored_image_id}); manual recovery required." >&2
    docker stop "${restore_id}" >/dev/null 2>&1 || true
    return 1
  fi
  if [[ -z "${previous_application_snapshot}" || ! -s "${previous_application_snapshot}" ]] \
      || ! verify_container_matches_snapshot "${previous_application_snapshot}" "${restore_id}"; then
    echo "ERROR: restored application configuration does not match the exact pre-rollout snapshot; manual recovery required." >&2
    docker stop "${restore_id}" >/dev/null 2>&1 || true
    return 1
  fi
  if ! wait_for_restored_application_readiness "${restore_id}"; then
    docker stop "${restore_id}" >/dev/null 2>&1 || true
    return 1
  fi
  echo "Restored exact pre-rollout application ${restore_id}." >&2
}

restore_previous_scheduled_worker_on_exit() {
  local original_status=$?
  local rollback_status="${original_status}"
  trap - EXIT
  set +e

  local restored_application_ready=true
  if ! restore_previous_application_if_safe; then
    restored_application_ready=false
    if [[ "${rollback_status}" == "0" ]]; then rollback_status=1; fi
  fi

  if [[ "${scheduled_worker_rollout_started}" == "true" \
        && "${scheduled_worker_cutover_complete}" != "true" \
        && "${previous_scheduled_worker_was_running}" == "true" \
        && "${pre_boundary_restore_proven_safe}" != "true" ]]; then
    echo "ERROR: refusing to restore the previous worker because unresolved pre-boundary provider claims may exist. Publishing remains stopped." >&2
    ARIES_APP_IMAGE="${TARGET_IMAGE}" docker compose stop "${scheduled_worker_service}" >/dev/null || true
  elif [[ "${scheduled_worker_rollout_started}" == "true" \
        && "${scheduled_worker_cutover_complete}" != "true" \
        && "${scheduled_worker_protocol_boundary_crossed}" == "true" ]]; then
    echo "ERROR: scheduled-worker protocol boundary crossed; refusing to restore the previous scheduled worker. Publishing remains stopped." >&2

    local current_worker_id
    current_worker_id="$(
      ARIES_APP_IMAGE="${TARGET_IMAGE}" docker compose ps -aq "${scheduled_worker_service}" 2>/dev/null
    )"
    if [[ -n "${current_worker_id}" && "${current_worker_id}" != "${previous_scheduled_worker_id}" ]]; then
      if ! docker rm -f "${current_worker_id}" >/dev/null; then
        echo "ERROR: could not remove failed replacement worker ${current_worker_id}; manual recovery required." >&2
      fi
    fi
    ARIES_APP_IMAGE="${TARGET_IMAGE}" docker compose stop "${scheduled_worker_service}" >/dev/null || true
  elif [[ "${scheduled_worker_rollout_started}" == "true" \
          && "${scheduled_worker_cutover_complete}" != "true" \
          && "${previous_scheduled_worker_was_running}" == "true" \
          && "${restored_application_ready}" != "true" ]]; then
    echo "ERROR: refusing to restore the previous worker until the exact pre-rollout application is ready. Publishing remains stopped." >&2
    ARIES_APP_IMAGE="${TARGET_IMAGE}" docker compose stop "${scheduled_worker_service}" >/dev/null || true
  elif [[ "${scheduled_worker_rollout_started}" == "true" \
          && "${scheduled_worker_cutover_complete}" != "true" \
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
        if [[ "${rollback_status}" == "0" ]]; then rollback_status=1; fi
        cleanup_scheduled_worker_snapshot
        cleanup_application_snapshot
        exit "${rollback_status}"
      fi
    fi

    local restore_id="${previous_scheduled_worker_id}"
    if ! docker inspect "${previous_scheduled_worker_id}" >/dev/null 2>&1; then
      if [[ -z "${previous_scheduled_worker_snapshot}" || ! -s "${previous_scheduled_worker_snapshot}" ]]; then
        echo "ERROR: pre-rollout worker was destroyed and no exact snapshot is available; manual recovery required." >&2
        if [[ "${rollback_status}" == "0" ]]; then rollback_status=1; fi
        cleanup_scheduled_worker_snapshot
        cleanup_application_snapshot
        exit "${rollback_status}"
      fi
      restore_id="$(restore_container_from_snapshot "${previous_scheduled_worker_snapshot}")"
      if [[ -z "${restore_id}" ]]; then
        echo "ERROR: exact pre-rollout worker recreation returned no container id; manual recovery required." >&2
        if [[ "${rollback_status}" == "0" ]]; then rollback_status=1; fi
        cleanup_scheduled_worker_snapshot
        cleanup_application_snapshot
        exit "${rollback_status}"
      fi
    fi

    if ! docker start "${restore_id}" >/dev/null; then
      echo "ERROR: failed to start restored pre-rollout worker ${restore_id}; manual recovery required." >&2
      if [[ "${rollback_status}" == "0" ]]; then rollback_status=1; fi
    else
      local restored_running restored_image_id
      restored_running="$(docker inspect -f '{{.State.Running}}' "${restore_id}" 2>/dev/null || echo false)"
      restored_image_id="$(docker inspect -f '{{.Image}}' "${restore_id}" 2>/dev/null || true)"
      if [[ "${restored_running}" != "true" \
            || -z "${previous_scheduled_worker_image_id}" \
            || "${restored_image_id}" != "${previous_scheduled_worker_image_id}" ]]; then
        echo "ERROR: restored worker verification failed (running=${restored_running}, image=${restored_image_id}); manual recovery required." >&2
        if [[ "${rollback_status}" == "0" ]]; then rollback_status=1; fi
      else
        echo "Restored exact pre-rollout scheduled worker ${restore_id}." >&2
      fi
    fi
  fi

  cleanup_scheduled_worker_snapshot
  cleanup_application_snapshot
  exit "${rollback_status}"
}

complete_scheduled_worker_cutover() {
  scheduled_worker_cutover_complete=true
  cleanup_scheduled_worker_snapshot
  cleanup_application_snapshot
  trap - EXIT
}

mark_scheduled_worker_protocol_boundary() {
  scheduled_worker_protocol_boundary_crossed=true
  cleanup_scheduled_worker_snapshot
  cleanup_application_snapshot
}

prepare_scheduled_worker_replacement() {
  if [[ "${scheduled_worker_protocol_boundary_crossed}" == "true" ]]; then
    return 0
  fi
  if [[ "${previous_scheduled_worker_was_running}" != "true" \
        || -z "${previous_scheduled_worker_id}" ]]; then
    return 0
  fi
  if [[ -z "${previous_scheduled_worker_snapshot}" || ! -s "${previous_scheduled_worker_snapshot}" ]]; then
    echo "ERROR: verified pre-rollout scheduled worker snapshot is unavailable." >&2
    return 1
  fi
}

prove_pre_boundary_restore_safe() {
  local proof_timeout_seconds="${ARIES_SCHEDULED_WORKER_RESTORE_PROOF_TIMEOUT_SECONDS:-120}"
  local proof_container_name="aries-scheduled-worker-restore-proof-$$"
  if [[ "${pre_boundary_restore_proven_safe}" == "true" ]]; then
    return 0
  fi
  if ! [[ "${proof_timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
    pre_boundary_restore_proven_safe=false
    echo "ERROR: ARIES_SCHEDULED_WORKER_RESTORE_PROOF_TIMEOUT_SECONDS must be a positive integer. Publishing remains stopped." >&2
    return 1
  fi

  if timeout --signal=TERM --kill-after=2s "${proof_timeout_seconds}s" \
      env ARIES_APP_IMAGE="${TARGET_IMAGE}" docker compose run --rm --no-deps \
      --name "${proof_container_name}" --entrypoint node aries-app \
      scripts/release/assert-no-unresolved-scheduled-claims.mjs; then
    docker rm -f "${proof_container_name}" >/dev/null 2>&1 || true
    pre_boundary_restore_proven_safe=true
    return 0
  fi

  docker rm -f "${proof_container_name}" >/dev/null 2>&1 || true
  pre_boundary_restore_proven_safe=false
  echo "ERROR: refusing to restore the previous application or worker because unresolved provider claims could not be ruled out. Publishing remains stopped." >&2
  return 1
}

replace_application_and_verify() {
  local target_image=$1
  local target_image_id=$2
  local service_name=$3
  local health_attempts=${4:-30}
  local health_sleep_seconds=${5:-5}
  local container_id container_image_id healthy=0 attempt

  if ! ARIES_APP_IMAGE="${target_image}" docker compose up -d --no-deps --force-recreate --pull always "${service_name}"; then
    echo "ERROR: Aries app recreate failed." >&2
    return 1
  fi

  if ! container_id="$(ARIES_APP_IMAGE="${target_image}" docker compose ps -q "${service_name}")" \
      || [[ -z "${container_id}" ]]; then
    echo "ERROR: Compose did not return a running container id for ${service_name}." >&2
    return 1
  fi
  if ! container_image_id="$(docker inspect -f '{{.Image}}' "${container_id}")"; then
    echo "ERROR: running Aries app image inspection failed." >&2
    return 1
  fi
  if [[ "${container_image_id}" != "${target_image_id}" ]]; then
    echo "ERROR: Running container image ${container_image_id} does not match target ${target_image_id}." >&2
    return 1
  fi

  for attempt in $(seq 1 "${health_attempts}"); do
    if docker compose exec -T "${service_name}" wget -qO- "http://127.0.0.1:${PORT:-3000}/" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep "${health_sleep_seconds}"
  done

  if [[ "${healthy}" != "1" ]]; then
    echo "ERROR: Aries app health check failed after deploy." >&2
    return 1
  fi
}

verify_scheduled_worker_manifest_and_readiness() {
  local target_image=$1
  local manifest_json manifest_image

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

  # Exercise the target image against live DB/schema/protocol access while
  # publishing is still stopped. Process state alone cannot prove readiness.
  local readiness_timeout_seconds="${ARIES_SCHEDULED_WORKER_READINESS_TIMEOUT_SECONDS:-120}"
  local readiness_container_name="aries-scheduled-worker-readiness-$$"
  if ! [[ "${readiness_timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: ARIES_SCHEDULED_WORKER_READINESS_TIMEOUT_SECONDS must be a positive integer." >&2
    return 1
  fi
  if ! timeout --signal=TERM --kill-after=2s "${readiness_timeout_seconds}s" \
      env ARIES_APP_IMAGE="${target_image}" docker compose run --rm \
      --name "${readiness_container_name}" --no-deps \
      -e ARIES_SCHEDULED_POSTS_READINESS_CHECK=1 "${scheduled_worker_service}"; then
    docker rm -f "${readiness_container_name}" >/dev/null 2>&1 || true
    echo "ERROR: replacement scheduled worker functional readiness failed; publishing remains stopped." >&2
    return 1
  fi
  docker rm -f "${readiness_container_name}" >/dev/null 2>&1 || true
}

replace_scheduled_worker_and_verify() {
  local target_image=$1
  local target_image_id=$2
  local replacement_id replacement_running replacement_image_id

  prepare_scheduled_worker_replacement
  verify_scheduled_worker_manifest_and_readiness "${target_image}"

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

  complete_scheduled_worker_cutover
  echo "Replacement scheduled worker ${replacement_id} is running on ${target_image_id}."
}

# This script is sourced by deploy.yml so the EXIT trap spans additive schema,
# compatible-app replacement, data cutover, and every worker replacement gate.
trap restore_previous_scheduled_worker_on_exit EXIT

if [[ "${quiesce_application_during_schema}" == "1" \
      && "${previous_application_was_running}" == "true" ]]; then
  docker compose stop "${application_service}"
fi
scheduled_worker_rollout_started=true
docker compose stop "${scheduled_worker_service}"
# A failed proof does not prevent the target-image migration/cutover from
# quarantining legacy claims. It does make every pre-boundary rollback unsafe:
# the EXIT trap will keep publishing stopped if schema/app replacement fails.
prove_pre_boundary_restore_safe || true

PGOPTIONS="-c lock_timeout=5s -c statement_timeout=120s" \
  ARIES_APP_IMAGE="${TARGET_IMAGE}" \
  timeout --signal=TERM 180s \
  docker compose run --rm --no-deps --entrypoint node aries-app scripts/init-db.js

# Direct execution is a schema-only smoke path. Its EXIT trap restores the
# exact old application first, waits for readiness, and only then restores the
# exact old worker. A sourced full deploy replaces and verifies both instead.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${pre_boundary_restore_proven_safe}" != "true" ]]; then
    echo "ERROR: direct schema execution completed, but unresolved pre-boundary provider claims may exist; refusing to restore the legacy application or worker. Publishing remains stopped." >&2
    # Deliberately leave the EXIT trap armed: it performs the final defensive
    # stop and preserves this nonzero result instead of rearming an unsafe
    # pre-boundary image after additive DDL succeeds.
    exit 1
  fi
fi
