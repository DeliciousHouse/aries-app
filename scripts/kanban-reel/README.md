# Kanban Reel Bridge — video via the kanban-video-orchestrator

Generate the weekly Aries video **Reel** through a dedicated Hermes
kanban-video-orchestrator pipeline instead of the inline content-generator
agent, then publish it through the normal Aries path.

## Why

The inline content-generator agent (one agent producing 7 images **and** a
video) skipped `video_generate` ~50% of runs (non-deterministic), and the
separate publish-stage intermittently emitted no schedule — so a generated reel
never became a published post. The kanban pipeline fixes this: a **dedicated
renderer worker** generates *only* the video, blocks cleanly on real failures,
and retries. Verified live 2026-06-26 — a dark/purple Aries reel published to
Instagram (`18604735954057574`) + Facebook (`27125820433726369`).

## Pipeline (one-time setup)

The standing `aries-weekly-reel` pipeline is created by the
`kanban-video-orchestrator` skill's `setup.sh` (a 5-profile team: director,
copywriter, visual-designer, **renderer-video**, editor + a workspace at
`~/projects/video-pipeline/aries-weekly-reel`). The renderer-video profile must
have the `video_gen` toolset (provider `xai` / `grok-imagine-video`) and working
xAI creds.

> **Clone gotcha:** `hermes profile create --clone` gives a profile an *empty*
> `xai-oauth` credential pool, so `video_generate` fails `auth_required`. Fix:
> `cp ~/.hermes/profiles/aries-content-generator/auth.json ~/.hermes/profiles/renderer-video/auth.json`
> (the resolver does a JWT-refresh a partial credential copy doesn't satisfy).
> `kanban-reel-bridge.sh` self-heals this automatically.

## Run it (host-side)

```bash
scripts/kanban-reel/kanban-reel-bridge.sh <aries_tenant_id> [jobId] [scheduleInMinutes]
# e.g. scripts/kanban-reel/kanban-reel-bridge.sh 15
```

The bridge:
1. ensures the renderer has xAI creds,
2. fires a kanban reel task on the `aries-weekly-reel` pipeline (`hermes kanban create --assignee director --workspace dir:…`),
3. waits for `output/final.mp4` (director → renderer-video grok render → editor ffmpeg normalize to 1080×1920),
4. copies the mp4 into the Hermes video cache mount, and
5. runs `ingest-kanban-reel.ts` inside the `aries-app` container.

`ingest-kanban-reel.ts` reuses the existing Aries path — `ingestProductionCreativeAssetsToDb` → `synthesizePublishPostsFromContentPackage` (the PR #733 content_package `placement:reel` fallback) → `upsertScheduledPost`. The
`scheduled-posts-worker` then publishes the reel via the Composio video branch.

**Requires** in the `aries-app` container: `ARIES_VIDEO_PUBLISH_ENABLED=1` and the
`HERMES_VIDEO_CACHE_MOUNT` bind-mount (PR #730).

## Productionizing (remaining work)

This is operational tooling proven end-to-end; to make it automatic per weekly
job:

1. **Trigger:** have the weekly pipeline enqueue a reel request (a `reel_requests`
   row or a flag on the job) when `videoRenderCount > 0`, instead of the inline
   video brief.
2. **Standing bridge service:** run the bridge as a host-side service (it needs
   the `hermes` CLI, which the containerized sidecars lack) that drains
   `reel_requests`, runs the loop per request, and is idempotent on the kanban
   `--idempotency-key` + the Aries `posts` idempotency key.
3. **Per-tenant briefs + per-job workspaces:** parameterize `brief.md` per tenant
   (from the brand kit) and use a per-job `--workspace dir:` so concurrent jobs
   don't clobber `output/final.mp4`.
4. **Bake the renderer cred + toolset config into setup** so a fresh host doesn't
   need the self-heal.
