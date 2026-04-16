#!/usr/bin/env bash
# Convert every .webm Playwright dropped into test-results/ into an MP4 next to it.
# Requires ffmpeg in PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS="${ROOT}/test-results"
OUTDIR="${ROOT}/clips-mp4"
mkdir -p "${OUTDIR}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install with: apt-get install ffmpeg (or brew install ffmpeg)"
  exit 1
fi

if [[ ! -d "${RESULTS}" ]]; then
  echo "No test-results/ directory. Run 'npm run record:all' first."
  exit 1
fi

find "${RESULTS}" -type f -name 'video.webm' -print0 | while IFS= read -r -d '' webm; do
  dir_name="$(basename "$(dirname "${webm}")")"
  out="${OUTDIR}/${dir_name}.mp4"
  echo "→ ${out}"
  ffmpeg -y -loglevel error -i "${webm}" \
    -c:v libx264 -preset slow -crf 18 \
    -pix_fmt yuv420p -movflags +faststart \
    "${out}"
done

echo ""
echo "Wrote MP4 clips to: ${OUTDIR}"
ls -lh "${OUTDIR}"
