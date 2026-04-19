# Video rendering fix — VM verification

After deploying the `fix/video-rendering-bugs` branch to the GCP VM, step through
the four checks below. Every step should pass; if one fails, stop and investigate
before merging.

## 1. Host cache directories contain real artifacts

OpenClaw + Lobster run on the host and must write to the shared bind mount that
the Aries container sees as `/data`. Pick the most recent Stage 3 `run_id` and
look at the host directory directly:

```bash
RUN_ID=$(ls -1t /home/node/data/lobster-stage3-cache | head -n 1)
ls /home/node/data/lobster-stage3-cache/"$RUN_ID"/
```

Expected: at least one `.mp4` file plus `production_review_preview.json` (and
any other Stage 3 outputs for that run).

## 2. Container sees the same files

`docker-compose.yml` now sets `LOBSTER_STAGE{1..4}_CACHE_DIR=/data/lobster-stage{N}-cache`
by default, matching the host layout. Confirm the container sees the same bytes:

```bash
docker exec aries-app ls /data/lobster-stage3-cache/"$RUN_ID"/
```

Expected: identical listing to step 1 — same file names, same sizes. If the
listing is empty, double-check that the host operator exported
`LOBSTER_STAGE{N}_CACHE_DIR` under `${ARIES_SHARED_DATA_ROOT}/lobster-stage{N}-cache`
**before** starting OpenClaw (see `DOCKER.md`).

## 3. Asset route returns `content-type: video/mp4`

Find a campaign that has a rendered video asset registered on the dashboard
and hit the asset endpoint with the tenant's authenticated session cookie:

```bash
JOB_ID="<your-campaign-job-id>"
VIDEO_ASSET_ID="<asset id starting with publish-video- or review-video->"
curl -I \
  -H "Cookie: <session cookie>" \
  "https://aries.sugarandleather.com/api/marketing/jobs/$JOB_ID/assets/$VIDEO_ASSET_ID"
```

Expected:

```
HTTP/2 200
content-type: video/mp4
content-length: <file size>
```

If the asset id is unknown, hit `GET /api/marketing/jobs/$JOB_ID` first and
look at `reviewBundle.platformPreviews[*].mediaAssets[*]` for a
`contentType: "video/mp4"` entry; use that entry's `url` to call the asset
route.

## 4. Review page renders `<video controls>` inline

Open the campaign's review page in a browser:

```
https://aries.sugarandleather.com/review/<reviewId>
```

Expected:

- A **Video preview** panel renders with an inline `<video controls>` element
  playing the `.mp4` — play, pause, and seek all work.
- If the review also has image assets, they appear in a parallel panel with an
  `<img>` tag (no placeholder "Open asset preview" text for assets that are
  actually images or videos).
- Signed-URL query strings (`?sig=...`) do **not** prevent inline rendering:
  the UI detects image/video by extension *before* any query suffix and by
  `content-type` header.

## What to roll back if a step fails

| Step fails | Likely cause |
| --- | --- |
| 1 | OpenClaw writing to a cache dir that is not under `ARIES_SHARED_DATA_ROOT`. Re-export `LOBSTER_STAGE{N}_CACHE_DIR` on the host and restart OpenClaw. |
| 2 | Host and container paths don't match. Check that `/data` mount equals the host's `ARIES_SHARED_DATA_ROOT`. |
| 3 | Old Aries image still running. Pull the new image and restart the container. |
| 4 | Browser cache. Hard-refresh; the `MediaPreview` component is client-side. |
