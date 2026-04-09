#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [[ "${ALLOW_DIRTY:-0}" != "1" ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree is dirty. Commit or stash changes before publishing." >&2
  exit 1
fi

DEFAULT_BRANCH="${DEFAULT_BRANCH:-$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')}"
if [[ -z "${DEFAULT_BRANCH}" ]]; then
  echo "ERROR: Unable to determine DEFAULT_BRANCH. Set DEFAULT_BRANCH explicitly." >&2
  exit 1
fi

if [[ -z "${GHCR_IMAGE:-}" ]]; then
  : "${GHCR_OWNER:?Set GHCR_OWNER or GHCR_IMAGE before publishing.}"
  owner_lc="${GHCR_OWNER,,}"
  GHCR_IMAGE="ghcr.io/${owner_lc}/aries-app"
fi

# GHCR requires lowercase registry paths; normalize so GitHub org casing does not break pushes.
GHCR_IMAGE="${GHCR_IMAGE,,}"

IMAGE_DESCRIPTION="${IMAGE_DESCRIPTION:-$(node -p "const pkg = require('./package.json'); pkg.description || ''")}"
if [[ -z "${IMAGE_DESCRIPTION}" ]]; then
  echo "ERROR: IMAGE_DESCRIPTION is required." >&2
  exit 1
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

docker buildx build \
  --platform "${PLATFORMS}" \
  --push \
  --label "org.opencontainers.image.source=https://github.com/DeliciousHouse/aries-app" \
  --label "org.opencontainers.image.revision=${GIT_SHA}" \
  --annotation "index:org.opencontainers.image.description=${IMAGE_DESCRIPTION}" \
  -t "${GHCR_IMAGE}:${GIT_SHA}" \
  -t "${GHCR_IMAGE}:${DEFAULT_BRANCH}" \
  -f Dockerfile \
  .

echo "Published ${GHCR_IMAGE}:${GIT_SHA}"
echo "Published ${GHCR_IMAGE}:${DEFAULT_BRANCH}"
