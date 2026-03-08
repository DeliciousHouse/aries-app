#!/usr/bin/env bash
# Extract and download ad assets from Meta Ads Library
# Usage: ./extract-and-download.sh <urls-json-file> <output-dir> <advertiser-slug>
#
# Input: JSON file with format: {"images": ["url1", ...], "videos": ["url1", ...], "posters": ["url1", ...]}
# Output: Downloaded files in output-dir named {slug}-{type}-{nn}.{ext}

set -euo pipefail

URLS_FILE="${1:?Usage: $0 <urls-json> <output-dir> <advertiser-slug>}"
OUTPUT_DIR="${2:?Usage: $0 <urls-json> <output-dir> <advertiser-slug>}"
SLUG="${3:?Usage: $0 <urls-json> <output-dir> <advertiser-slug>}"
DELAY="${4:-1}"  # seconds between downloads (default 1)

mkdir -p "$OUTPUT_DIR"

echo "📥 Downloading assets for: $SLUG"
echo "   Output: $OUTPUT_DIR"

# Download images
n=0
jq -r '.images[]' "$URLS_FILE" 2>/dev/null | while read -r url; do
  n=$((n+1))
  fname="${SLUG}-image-$(printf '%02d' $n).jpg"
  echo "   🖼  $fname"
  curl -sL -o "$OUTPUT_DIR/$fname" "$url"
  sleep "$DELAY"
done

# Download videos
n=0
jq -r '.videos[]' "$URLS_FILE" 2>/dev/null | while read -r url; do
  n=$((n+1))
  fname="${SLUG}-video-$(printf '%02d' $n).mp4"
  echo "   🎬 $fname"
  curl -sL -o "$OUTPUT_DIR/$fname" "$url"
  sleep "$DELAY"
done

# Download video posters
n=0
jq -r '.posters[]' "$URLS_FILE" 2>/dev/null | while read -r url; do
  n=$((n+1))
  fname="${SLUG}-poster-$(printf '%02d' $n).jpg"
  echo "   📸 $fname"
  curl -sL -o "$OUTPUT_DIR/$fname" "$url"
  sleep "$DELAY"
done

echo "✅ Done. Files saved to $OUTPUT_DIR/"
ls -lh "$OUTPUT_DIR/${SLUG}-"* 2>/dev/null || echo "   (no files downloaded)"
