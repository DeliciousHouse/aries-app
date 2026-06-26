#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# kanban-reel-bridge.sh — Aries ↔ kanban-video-orchestrator bridge.
#
# Runs ON THE HOST (needs the `hermes` CLI + the kanban pipeline + docker access
# to the aries-app container). Fires a reel render on the standing
# `aries-weekly-reel` kanban pipeline (director → renderer-video → editor),
# waits for output/final.mp4, then ingests it into Aries as a scheduled,
# publishable IG+FB Reel post (via ingest-kanban-reel.ts inside the container).
#
# This is the deterministic alternative to the inline content-generator video:
# a dedicated renderer worker generates ONLY the video, blocks cleanly on real
# failures, and retries — instead of the multi-asset agent silently skipping it.
#
# Prereqs (one-time): the `aries-weekly-reel` pipeline must exist
#   (kanban-video-orchestrator setup.sh — see README), the renderer-video
#   profile must have working xAI creds (this script self-heals the clone bug),
#   ARIES_VIDEO_PUBLISH_ENABLED=1 in the aries-app container, and the
#   HERMES_VIDEO_CACHE_MOUNT bind-mount (PR #730).
#
# Usage:  kanban-reel-bridge.sh <aries_tenant_id> [jobId] [scheduleInMinutes]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
export PATH="/home/node/.local/bin:$PATH"

TENANT_ID="${1:?usage: kanban-reel-bridge.sh <aries_tenant_id> [jobId] [minutes]}"
JOBID="${2:-mkt_kanbanreel_$(date -u +%Y%m%d%H%M%S)}"
SCHED_MIN="${3:-6}"

PIPE_TENANT="aries-weekly-reel"
WS="$HOME/projects/video-pipeline/aries-weekly-reel"
VIDDIR="$HOME/.hermes/profiles/aries-content-generator/cache/videos"
APP="aries-app-aries-app-1"
RENDERER_HOME="$HOME/.hermes/profiles/renderer-video"
WORKING_AUTH="$HOME/.hermes/profiles/aries-content-generator/auth.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 0. Self-heal the cloned renderer's xAI creds (clone bug: empty credential pool).
if ! /home/node/.hermes/hermes-agent/venv/bin/python - <<PY 2>/dev/null
import sys, os
sys.path.insert(0, "/home/node/.hermes/hermes-agent")
os.environ["HERMES_HOME"] = "$RENDERER_HOME"
from tools.xai_http import resolve_xai_http_credentials
sys.exit(0 if (resolve_xai_http_credentials() or {}).get("api_key") else 1)
PY
then
  echo "[bridge] renderer-video has no usable xAI creds — copying working auth.json"
  cp -a "$WORKING_AUTH" "$RENDERER_HOME/auth.json"
fi

# 1. Clear any stale output and fire the render task on the standing pipeline.
rm -f "$WS/output/final.mp4" "$WS/scenes/scene-01/clip.mp4" 2>/dev/null || true
echo "[bridge] firing kanban reel task (tenant aries job $JOBID)…"
TASK="$(hermes kanban create "Produce Aries reel ($JOBID)" \
  --body "Read brief.md, TEAM.md, taste/. Produce the single 9:16 ~15s Aries reel to output/final.mp4 via renderer-video + editor (grok video_generate). Aries job: $JOBID." \
  --assignee director --workspace "dir:$WS" --tenant "$PIPE_TENANT" --json 2>/dev/null \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")"
echo "[bridge] task: $TASK"

# 2. Poll for output/final.mp4 (renderer ~3-5 min + editor; cap ~40 min).
echo "[bridge] waiting for output/final.mp4…"
for i in $(seq 1 40); do
  [ -f "$WS/output/final.mp4" ] && break
  # surface a blocked render early
  if hermes kanban list --tenant "$PIPE_TENANT" 2>/dev/null | grep -qiE "renderer-video.*blocked"; then
    echo "[bridge] renderer-video BLOCKED — inspect: hermes kanban show <task>"; exit 2
  fi
  sleep 60
done
[ -f "$WS/output/final.mp4" ] || { echo "[bridge] TIMEOUT: no final.mp4 after ~40m"; exit 1; }
echo "[bridge] reel rendered: $(du -h "$WS/output/final.mp4" | awk '{print $1}')"

# 3. Copy into the Hermes video cache (the Aries read-only mount) and ingest.
BASENAME="kanban_reel_${JOBID}.mp4"
cp "$WS/output/final.mp4" "$VIDDIR/$BASENAME"
docker cp "$SCRIPT_DIR/ingest-kanban-reel.ts" "$APP:/app/ingest-kanban-reel.ts"
docker exec "$APP" sh -c "cd /app && ./node_modules/.bin/tsx ingest-kanban-reel.ts '$BASENAME' '$JOBID' '$TENANT_ID' '$SCHED_MIN'"
docker exec "$APP" rm -f /app/ingest-kanban-reel.ts
echo "[bridge] DONE — reel ingested + scheduled for Aries tenant $TENANT_ID (job $JOBID)."
