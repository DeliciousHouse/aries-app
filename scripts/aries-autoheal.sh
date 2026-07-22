#!/bin/sh
set -eu

AUTOHEAL_CONTAINER_LABEL="${AUTOHEAL_CONTAINER_LABEL:-com.delicioushouse.aries.autoheal}"
AUTOHEAL_CONTAINER_LABEL_VALUE="${AUTOHEAL_CONTAINER_LABEL_VALUE:-true}"
AUTOHEAL_INTERVAL="${AUTOHEAL_INTERVAL:-30}"
AUTOHEAL_MAX_RESTARTS_PER_WINDOW="${AUTOHEAL_MAX_RESTARTS_PER_WINDOW:-3}"
AUTOHEAL_RESTART_WINDOW_SECONDS="${AUTOHEAL_RESTART_WINDOW_SECONDS:-900}"
AUTOHEAL_STOP_TIMEOUT="${AUTOHEAL_STOP_TIMEOUT:-10}"
AUTOHEAL_STATE_DIR="${AUTOHEAL_STATE_DIR:-/var/lib/aries-autoheal}"
DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"

require_positive_integer() {
  name="$1"
  value="$2"
  case "$value" in
    ''|*[!0-9]*)
      echo "ERROR: ${name} must be a positive integer (received ${value:-empty})." >&2
      exit 2
      ;;
  esac
  if [ "$value" -le 0 ]; then
    echo "ERROR: ${name} must be greater than zero (received ${value})." >&2
    exit 2
  fi
}

require_container_id() {
  container_id="$1"
  case "$container_id" in
    ''|*[!0-9a-fA-F]*)
      echo "ERROR: invalid Docker container id ${container_id:-empty}." >&2
      exit 2
      ;;
  esac
}

require_positive_integer AUTOHEAL_INTERVAL "$AUTOHEAL_INTERVAL"
require_positive_integer AUTOHEAL_MAX_RESTARTS_PER_WINDOW "$AUTOHEAL_MAX_RESTARTS_PER_WINDOW"
require_positive_integer AUTOHEAL_RESTART_WINDOW_SECONDS "$AUTOHEAL_RESTART_WINDOW_SECONDS"
require_positive_integer AUTOHEAL_STOP_TIMEOUT "$AUTOHEAL_STOP_TIMEOUT"
mkdir -p "$AUTOHEAL_STATE_DIR"

state_file_for() {
  container_id="$1"
  require_container_id "$container_id"
  printf '%s/%s.restarts\n' "$AUTOHEAL_STATE_DIR" "$container_id"
}

suppression_file_for() {
  container_id="$1"
  require_container_id "$container_id"
  printf '%s/%s.suppressed\n' "$AUTOHEAL_STATE_DIR" "$container_id"
}

prune_restart_history() {
  container_id="$1"
  now="$2"
  require_positive_integer now "$now"
  state_file="$(state_file_for "$container_id")"
  cutoff=$((now - AUTOHEAL_RESTART_WINDOW_SECONDS))
  : >> "$state_file"
  awk -v cutoff="$cutoff" '$1 > cutoff { print $1 }' "$state_file" > "${state_file}.tmp"
  mv "${state_file}.tmp" "$state_file"
}

restart_decision() {
  container_id="$1"
  now="$2"
  prune_restart_history "$container_id" "$now"
  state_file="$(state_file_for "$container_id")"
  restart_count="$(wc -l < "$state_file" | tr -d '[:space:]')"
  if [ "$restart_count" -ge "$AUTOHEAL_MAX_RESTARTS_PER_WINDOW" ]; then
    printf 'suppressed\n'
  else
    printf 'restart\n'
  fi
}

record_restart() {
  container_id="$1"
  now="$2"
  prune_restart_history "$container_id" "$now"
  state_file="$(state_file_for "$container_id")"
  printf '%s\n' "$now" >> "$state_file"
}

case "${1:-}" in
  --decision)
    restart_decision "${2:-}" "${3:-}"
    exit 0
    ;;
  --record)
    record_restart "${2:-}" "${3:-}"
    exit 0
    ;;
esac

if [ "$#" -ne 0 ]; then
  echo "ERROR: unsupported arguments: $*" >&2
  exit 2
fi

if [ ! -S "$DOCKER_SOCKET" ]; then
  echo "ERROR: Docker socket is not available at ${DOCKER_SOCKET}." >&2
  exit 1
fi

selector="${AUTOHEAL_CONTAINER_LABEL}=${AUTOHEAL_CONTAINER_LABEL_VALUE}"
filters="$(jq -nr --arg selector "$selector" '{health:["unhealthy"],label:[$selector]} | @uri')"

echo "[aries-autoheal] watching ${selector}; max ${AUTOHEAL_MAX_RESTARTS_PER_WINDOW} restarts per ${AUTOHEAL_RESTART_WINDOW_SECONDS}s window"

while :; do
  now="$(date +%s)"
  if unhealthy_ids="$(
    curl --silent --show-error --fail \
      --unix-socket "$DOCKER_SOCKET" \
      "http://localhost/containers/json?filters=${filters}" \
      | jq -r '.[].Id'
  )"; then
    for container_id in $unhealthy_ids; do
      decision="$(restart_decision "$container_id" "$now")"
      suppression_file="$(suppression_file_for "$container_id")"
      if [ "$decision" = "suppressed" ]; then
        if [ ! -f "$suppression_file" ]; then
          echo "[aries-autoheal] restart budget exhausted for ${container_id}; leaving it unhealthy for operator visibility until the ${AUTOHEAL_RESTART_WINDOW_SECONDS}s window expires" >&2
          : > "$suppression_file"
        fi
        continue
      fi

      if curl --silent --show-error --fail \
        --request POST \
        --unix-socket "$DOCKER_SOCKET" \
        "http://localhost/containers/${container_id}/restart?t=${AUTOHEAL_STOP_TIMEOUT}" \
        >/dev/null; then
        record_restart "$container_id" "$now"
        rm -f "$suppression_file"
        echo "[aries-autoheal] restarted unhealthy container ${container_id}"
      else
        echo "[aries-autoheal] failed to restart unhealthy container ${container_id}; the failed API call did not consume restart budget" >&2
      fi
    done
  else
    echo "[aries-autoheal] failed to query unhealthy Aries containers; retrying in ${AUTOHEAL_INTERVAL}s" >&2
  fi

  sleep "$AUTOHEAL_INTERVAL"
done
