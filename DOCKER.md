# Aries App Containerization

## Files
- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.local.yml`
- `.dockerignore`

## Deployment contract
- Application code is baked into the image and mounted internally at `/app`.
- Writable runtime data lives under `/data` only.
- Production runtime uses Docker named volumes for `/data`.
- Source bind mounts are development-only.

## Production release

For `aries-app`, deploy by publishing the image for the exact commit SHA first, then pushing that same commit to `master`.
The GitHub Actions deploy workflow expects `ghcr.io/delicioushouse/aries-app:<sha>` to exist before the self-hosted deploy host pulls it locally.

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
- `DB_POOL_MAX` (optional; default `20` per worker)
- `OPENCLAW_GATEWAY_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_SESSION_KEY` (optional; default `main`)
- `OPENCLAW_LOBSTER_CWD` (optional)
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
- Each worker gets `APP_INSTANCE_ID`, which appears in the pg `application_name`
  as `aries-app:<id>` for connection debugging.

Why this is not PM2: PM2 was evaluated for this deploy-layer fix, but adding it
as an application dependency introduces extra license/audit surface. Native Node
cluster mode gives this container the same single-port, multi-worker request
load-balancing shape with fewer production dependencies.

Example four-worker deploy with smaller per-worker pg pools:

```bash
ARIES_WEB_CONCURRENCY=4 DB_POOL_MAX=10 \
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

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
