# Aries App Containerization

## Files
- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.local.yml`
- `.dockerignore`

## Deployment contract
- Application code is baked into the image and mounted internally at `/app`.
- Writable runtime data lives under `/data` only.
- Production Compose mounts `/data` from `${ARIES_SHARED_DATA_ROOT:-/home/node/data}` so Lobster caches and generated assets survive container replacement.
- Source bind mounts are development-only.

## Production release

For `aries-app`, deploy by merging or pushing to `master`. The GitHub Actions Deploy workflow builds and publishes `ghcr.io/delicioushouse/aries-app:<sha>` for the exact target commit, then the self-hosted deploy host pulls that pinned image and force-recreates the `aries-app` service.

Manual deploys still use workflow dispatch with an explicit image tag. Use the full commit SHA for normal production recovery so the workflow can build and verify the exact image before restart:

```bash
gh workflow run Deploy --ref master \
  -f image_tag=<full-commit-sha> \
  -f git_ref=<full-commit-sha>
```

## Build
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml build
```

`docker-compose.yml` now owns the host port publish for `aries-app`, so deploys and production-style runs work even when only the base file is used. `docker-compose.local.yml` remains a merged override for localhost defaults and the optional `aries-app-dev` helper service.

## Required environment
- `APP_BASE_URL`
- `ARIES_APP_IMAGE` (optional image/tag override, default: `aries-app:local`)
- `ARIES_PROCESS_MANAGER` (optional; default `cluster`, set `node` for one-process rollback)
- `ARIES_WEB_CONCURRENCY` (optional; default `2`, accepts a positive integer or `max`)
- `ARIES_WORKER_MAX_RESTARTS` (optional; default `5`, exits the container if all workers exceed the restart cap)
- `DB_POOL_MAX` (optional; default `20` per worker)
- `OPENCLAW_GATEWAY_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_SESSION_KEY` (optional; default `main`)
- `OPENCLAW_LOBSTER_CWD` (optional)
- `LOBSTER_MEDIA_GATEWAY_ENABLED` (optional; set `1` to route Stage 4 image/video/text QA through OpenClaw)
- `LOBSTER_VIDEO_RENDER_ENABLED` (optional; still required before video generation runs)
- `LOBSTER_GATEWAY_IMAGE_MODEL` / `OPENCLAW_IMAGE_GENERATION_MODEL` (optional OpenClaw image model override)
- `LOBSTER_GATEWAY_VIDEO_MODEL` / `OPENCLAW_VIDEO_GENERATION_MODEL` (optional OpenClaw video model override)
- `LOBSTER_MEDIA_GATEWAY_ALLOW_DIRECT_FALLBACK` (optional local/dev escape hatch only)
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXTAUTH_URL`
- `AUTH_URL`
- `AUTH_TRUST_HOST`
- `NEXTAUTH_SECRET`

## Run
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

### OpenClaw media gateway

`OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, and `OPENCLAW_SESSION_KEY`
only make the gateway reachable. They do not enable Lobster Stage 4 media
delegation by themselves. Set `LOBSTER_MEDIA_GATEWAY_ENABLED=1` when image
generation, video generation, and non-SVG image text QA should go through
OpenClaw's `image_generate`, `video_generate`, and `image` tools.

Video generation still has its own cost/safety gate:

```bash
LOBSTER_MEDIA_GATEWAY_ENABLED=1 \
LOBSTER_VIDEO_RENDER_ENABLED=1 \
LOBSTER_GATEWAY_IMAGE_MODEL=openai/gpt-image-2 \
LOBSTER_GATEWAY_VIDEO_MODEL=openai/sora-2 \
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

Leave the gateway model variables unset when you want OpenClaw to pick from its
configured provider registry. Use the `LOBSTER_GATEWAY_*` or `OPENCLAW_*` model
overrides only when the OpenClaw runtime is known to support that model. Direct
fallback is fail-closed by default; set `LOBSTER_MEDIA_GATEWAY_ALLOW_DIRECT_FALLBACK=1`
only for local/dev runs where falling back to direct provider keys is acceptable.

### Production web concurrency

The production container starts through `scripts/start-runtime.mjs`, which defaults to
`ARIES_PROCESS_MANAGER=cluster`. The launcher uses Node's built-in cluster primary
to run multiple `next start` workers on the same container port, so concurrent
requests are distributed across workers without adding a new production PM2
package or an in-container Nginx/Caddy hop. The external reverse proxy can keep
the single published upstream `${PORT:-3000}`.

Tuning knobs:

- `ARIES_WEB_CONCURRENCY=2` by default. Set a positive integer for an exact
  worker count or `max` for one worker per detected CPU. `WEB_CONCURRENCY` is
  also recognized by the launcher when `ARIES_WEB_CONCURRENCY` is unset outside
  Compose; Compose users should set `ARIES_WEB_CONCURRENCY` directly.
- `DB_POOL_MAX=20` is per worker. Total possible Postgres clients are roughly
  `ARIES_WEB_CONCURRENCY * DB_POOL_MAX`, so lower `DB_POOL_MAX` before raising
  worker count aggressively on a database with tight `max_connections`.
- `ARIES_PROCESS_MANAGER=node` is the emergency rollback path. It keeps the same
  image and runs a single `next start` process on `${PORT:-3000}`.
- `ARIES_WORKER_MAX_RESTARTS=5` caps per-worker crash restarts. If every worker
  exceeds the cap, PID 1 exits so Docker can restart the container instead of
  leaving an unhealthy cluster primary alive.
- Each worker gets `APP_INSTANCE_ID`, which appears in the pg `application_name`
  as `aries-app:<id>` for connection debugging.

Why this is not PM2: PM2 was evaluated for this deploy-layer fix, but adding it
as an application dependency introduces extra license/audit surface. Native Node
cluster mode gives this container the same single-port, multi-worker request
load-balancing shape with fewer production dependencies.

Example four-worker deploy with smaller per-worker pg pools. This is the initial
profile for roughly 50 people/users if the database can spare about 40 app
connections for this container:

```bash
ARIES_WEB_CONCURRENCY=4 DB_POOL_MAX=10 \
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

For multiple app containers, reserve room for migrations, admin sessions, and
Postgres maintenance when doing the math. A safe first-pass budget is:

```text
total_app_connections = containers * ARIES_WEB_CONCURRENCY * DB_POOL_MAX
```

Do not raise `ARIES_WEB_CONCURRENCY` without lowering `DB_POOL_MAX` or confirming
that `total_app_connections` still fits the database's `max_connections` with
headroom.

Readiness/liveness:

- Container liveness remains `GET /` on the published port.
- `GET /api/health/db` returns `{ status, poolStats, roundTripMs }` and is the
  better load-balancer readiness probe when the proxy should only send traffic
  to app workers that can reach Postgres.

### Job endpoint benchmark

Use an authenticated cookie jar for the tenant that owns the campaign job:

```bash
BASE_URL="https://<aries-host>"
JOB_ID="<campaign-job-id>"
COOKIE_JAR="cookies.txt"

curl -b "$COOKIE_JAR" -o /dev/null -sS \
  -w "serial: status=%{http_code} total=%{time_total}s\n" \
  "$BASE_URL/api/marketing/jobs/$JOB_ID"

seq 1 8 | xargs -I{} -P8 sh -c '
  curl -b "$0" -o /dev/null -sS \
    -w "parallel {}: status=%{http_code} total=%{time_total}s\\n" \
    "$1/api/marketing/jobs/$2"
' "$COOKIE_JAR" "$BASE_URL" "$JOB_ID"
```

Compare the serial time and the worst 8-concurrent time before and after changing
`ARIES_WEB_CONCURRENCY`/`DB_POOL_MAX`.

For the first 50-person launch profile, also run a short 50-concurrent smoke
check against the health and job endpoints. This catches connection-pool pressure
that an 8-request check can miss. Prefer the reusable Node smoke command for
repeatability:

```bash
SCALE_SMOKE_BASE_URL="$BASE_URL" npm run smoke:scale50
```

Use the shell one-liner variant when Node dependencies are not available:

```bash
seq 1 50 | xargs -I{} -P50 sh -c '
  curl -o /dev/null -sS \
    -w "health {}: status=%{http_code} total=%{time_total}s\\n" \
    "$0/api/health/db"
' "$BASE_URL"

seq 1 50 | xargs -I{} -P50 sh -c '
  curl -b "$0" -o /dev/null -sS \
    -w "job {}: status=%{http_code} total=%{time_total}s\\n" \
    "$1/api/marketing/jobs/$2"
' "$COOKIE_JAR" "$BASE_URL" "$JOB_ID"
```

To pin a specific private GHCR tag without editing compose files:
```bash
ARIES_APP_IMAGE=ghcr.io/<owner-or-org>/aries-app:<tag> \
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

## Stop
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml down
```

## Notes
- Production should not bind mount the repository into `/app`.
- Keep real secrets out of git.
- The runtime contract remains `CODE_ROOT=/app` and `DATA_ROOT=/data`.
- The main `aries-app` service publishes `${PORT:-3000}` from the base compose file; the local override merges into that same service instead of launching a duplicate production instance.
- Workflow execution is delegated through OpenClaw.

## Lobster stage cache directories

Lobster writes stage artifacts (images, `.mp4` videos, review packages) to the
`$LOBSTER_STAGE{1..4}_CACHE_DIR` paths. Because OpenClaw + Lobster run on the
host while Aries runs in a container with Postgres storing only metadata, both
processes must resolve to **identical absolute paths**. Route the four cache
dirs onto the shared `ARIES_SHARED_DATA_ROOT` bind mount so `/data/...` in the
container matches `${ARIES_SHARED_DATA_ROOT}/...` on the host.

Before starting OpenClaw on the host, export:

```bash
export LOBSTER_STAGE1_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/lobster-stage1-cache"
export LOBSTER_STAGE2_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/lobster-stage2-cache"
export LOBSTER_STAGE3_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/lobster-stage3-cache"
export LOBSTER_STAGE4_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/lobster-stage4-cache"
```

The container defaults to `/data/lobster-stage{N}-cache` in `docker-compose.yml`,
which equals those host paths via the `/data` bind. Override either side only
if you have a reason — if they diverge, Aries silently cannot see the files.
