#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Load .env so GHCR_OWNER, GHCR_IMAGE, etc. are available without manual export.
# Strip CRLF for Windows-edited files; relax nounset while sourcing.
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set +u
  set -a
  # shellcheck disable=SC1091
  source <(sed 's/\r$//' "${REPO_ROOT}/.env")
  set +a
  set -u
fi

# Skip dirty check in linked worktrees (git-dir differs from git-common-dir).
if [[ "${ALLOW_DIRTY:-0}" != "1" ]] && [[ "$(git rev-parse --git-dir)" == "$(git rev-parse --git-common-dir)" ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree is dirty. Commit or stash changes before publishing." >&2
  exit 1
fi

if [[ -z "${GHCR_IMAGE:-}" ]]; then
  : "${GHCR_OWNER:?Set GHCR_OWNER or GHCR_IMAGE before publishing.}"
  owner_lc="${GHCR_OWNER,,}"
  GHCR_IMAGE="ghcr.io/${owner_lc}/aries-app"
fi

# GHCR requires lowercase registry paths; normalize so GitHub org casing does not break pushes.
GHCR_IMAGE="${GHCR_IMAGE,,}"

if [[ -z "${IMAGE_DESCRIPTION:-}" ]] && command -v python3 >/dev/null 2>&1; then
  IMAGE_DESCRIPTION="$(python3 - <<'PY'
import json
from pathlib import Path

try:
    package = json.loads(Path('package.json').read_text())
except Exception:
    print('')
else:
    print(package.get('description') or '')
PY
)"
fi
if [[ -z "${IMAGE_DESCRIPTION:-}" ]]; then
  IMAGE_DESCRIPTION="Aries marketing automation runtime"
fi

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  GHCR_USERNAME="${GHCR_USERNAME:-${GHCR_OWNER:-}}"
  GHCR_USERNAME="${GHCR_USERNAME,,}"
  if [[ -z "${GHCR_USERNAME}" ]]; then
    echo "ERROR: GHCR_USERNAME is required when GHCR_TOKEN is provided." >&2
    exit 1
  fi
  auth="$(printf '%s:%s' "${GHCR_USERNAME}" "${GHCR_TOKEN}" | openssl base64 -A)"
  export DOCKER_AUTH_CONFIG
  DOCKER_AUTH_CONFIG="$(printf '{"auths":{"ghcr.io":{"auth":"%s"}}}' "${auth}")"
fi

GIT_SHA="$(git rev-parse HEAD)"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
metadata_file="$(mktemp)"
trap 'rm -f "${metadata_file}"' EXIT

build_args=(
  --platform "${PLATFORMS}"
  --output "type=image,name=${GHCR_IMAGE},push-by-digest=true,name-canonical=true,push=true"
  --metadata-file "${metadata_file}"
  --label "org.opencontainers.image.source=https://github.com/DeliciousHouse/aries-app"
  --label "org.opencontainers.image.revision=${GIT_SHA}"
  --annotation "index:org.opencontainers.image.description=${IMAGE_DESCRIPTION}"
  -f Dockerfile
  .
)

docker buildx build "${build_args[@]}"
IMAGE_DIGEST="$(node -e "const m=require(process.argv[1]); process.stdout.write(m['containerimage.digest'] || '')" "${metadata_file}")"
if [[ ! "${IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: Docker build did not return a valid image digest." >&2
  exit 1
fi

IMAGE_ALIAS="${GHCR_IMAGE}:${GIT_SHA}" \
  IMAGE_SOURCE="${GHCR_IMAGE}@${IMAGE_DIGEST}" \
  IMAGE_DIGEST="${IMAGE_DIGEST}" \
  ALIAS_DESCRIPTION="Deploy SHA tag" \
  node scripts/release/release-state.mjs ensure-alias

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "digest=${IMAGE_DIGEST}" >> "${GITHUB_OUTPUT}"
fi
echo "Published immutable ${GHCR_IMAGE}:${GIT_SHA}@${IMAGE_DIGEST}"
