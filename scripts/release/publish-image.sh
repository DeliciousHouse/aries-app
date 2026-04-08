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
  GHCR_IMAGE="ghcr.io/${GHCR_OWNER}/aries-app"
fi

: "${OCI_SOURCE_REPO:?Set OCI_SOURCE_REPO=owner/aries-app before publishing.}"

IMAGE_DESCRIPTION="${IMAGE_DESCRIPTION:-$(node -p "const pkg = require('./package.json'); pkg.description || ''")}"
if [[ -z "${IMAGE_DESCRIPTION}" ]]; then
  echo "ERROR: IMAGE_DESCRIPTION is required." >&2
  exit 1
fi

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  GHCR_USERNAME="${GHCR_USERNAME:-${GHCR_OWNER:-}}"
  if [[ -z "${GHCR_USERNAME}" ]]; then
    echo "ERROR: GHCR_USERNAME is required when GHCR_TOKEN is provided." >&2
    exit 1
  fi
  printf '%s' "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USERNAME}" --password-stdin >/dev/null
fi

GIT_SHA="$(git rev-parse HEAD)"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

docker buildx build \
  --platform "${PLATFORMS}" \
  --push \
  --label "org.opencontainers.image.source=https://github.com/${OCI_SOURCE_REPO}" \
  --label "org.opencontainers.image.revision=${GIT_SHA}" \
  --annotation "index:org.opencontainers.image.description=${IMAGE_DESCRIPTION}" \
  -t "${GHCR_IMAGE}:${GIT_SHA}" \
  -t "${GHCR_IMAGE}:${DEFAULT_BRANCH}" \
  -f Dockerfile \
  .

echo "Published ${GHCR_IMAGE}:${GIT_SHA}"
echo "Published ${GHCR_IMAGE}:${DEFAULT_BRANCH}"
