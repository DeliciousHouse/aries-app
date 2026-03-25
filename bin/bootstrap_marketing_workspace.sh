#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${ROOT_DIR}/output"
CLAWD_DIR="${HOME}/clawd"
CLAWD_OUTPUT="${CLAWD_DIR}/output"

mkdir -p "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}/meta-ads"
mkdir -p "${OUTPUT_DIR}/landing-pages"
mkdir -p "${OUTPUT_DIR}/ad-images"
mkdir -p "${OUTPUT_DIR}/scripts"
mkdir -p "${CLAWD_DIR}"

if [ ! -e "${CLAWD_OUTPUT}" ]; then
  ln -s "${OUTPUT_DIR}" "${CLAWD_OUTPUT}"
  CLAWD_OUTPUT_MODE="symlinked"
elif [ -L "${CLAWD_OUTPUT}" ]; then
  CLAWD_OUTPUT_MODE="symlinked"
else
  CLAWD_OUTPUT_MODE="existing-directory"
fi

jq -n       --arg ok "true"       --arg rootDir "${ROOT_DIR}"       --arg outputDir "${OUTPUT_DIR}"       --arg clawdOutput "${CLAWD_OUTPUT}"       --arg clawdOutputMode "${CLAWD_OUTPUT_MODE}"       '{
    ok: ($ok == "true"),
    rootDir: $rootDir,
    outputDir: $outputDir,
    clawdOutput: $clawdOutput,
    clawdOutputMode: $clawdOutputMode
  }'
