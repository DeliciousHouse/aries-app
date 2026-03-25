#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_WORKSPACE="${1:-${HOME}/.openclaw/workspace}"

mkdir -p "${TARGET_WORKSPACE}/skills"
mkdir -p "${TARGET_WORKSPACE}/lobster"
mkdir -p "${TARGET_WORKSPACE}/bin"

cp -R "${ROOT_DIR}/skills/." "${TARGET_WORKSPACE}/skills/"
cp -R "${ROOT_DIR}/lobster/." "${TARGET_WORKSPACE}/lobster/"
cp -R "${ROOT_DIR}/bin/." "${TARGET_WORKSPACE}/bin/"
cp "${ROOT_DIR}/TOOLS.md" "${TARGET_WORKSPACE}/TOOLS.marketing-pipeline.md"
cp "${ROOT_DIR}/.env.example" "${TARGET_WORKSPACE}/.env.marketing-pipeline.example"

jq -n \
  --arg workspace "${TARGET_WORKSPACE}" \
  --arg skillsDir "${TARGET_WORKSPACE}/skills" \
  --arg lobsterDir "${TARGET_WORKSPACE}/lobster" \
  --arg binDir "${TARGET_WORKSPACE}/bin" \
  '{
    ok: true,
    workspace: $workspace,
    skillsDir: $skillsDir,
    lobsterDir: $lobsterDir,
    binDir: $binDir
  }'
