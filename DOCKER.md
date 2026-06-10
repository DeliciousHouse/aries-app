# Aries App Containerization

## Files
- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.local.yml`
- `.dockerignore`

## Deployment contract
- Application code is baked into the image and mounted internally at `/app`.
- Writable runtime data lives under `/data` only.
- Production Compose mounts `/data` from `${ARIES_SHARED_DATA_ROOT:-/home/node/data}` so generated artifacts survive container replacement.
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
- `ARIES_REAPER_ENABLED` (optional; default `1` — enables the in-process stale-run reaper side-process that marks stuck marketing jobs `failed_stale` every 5 minutes)
- `ARIES_REAPER_INTERVAL_MS` (optional; default `300000` — reaper sweep interval in milliseconds)
- `ARIES_KANBAN_GC_ENABLED` (optional; default `1` — enables the in-process Hermes kanban GC side-process)
- `ARIES_KANBAN_GC_INTERVAL_MS` (optional; default `86400000` — kanban GC interval in milliseconds)
- `ARIES_KANBAN_GC_RETENTION_DAYS` (optional; default `7` — archive completed kanban tasks older than this many days before running `hermes kanban gc`)
- `ARIES_RECONCILER_ENABLED` (optional; default `1` — enables the durable Hermes run reconciler side-process that ingests finished marketing runs; replaces the unreliable in-process poll-bridge)
- `ARIES_RECONCILER_INTERVAL_MS` (optional; default `60000` — reconciler sweep interval in milliseconds; beats the reaper's tightest stage threshold)
- `DB_POOL_MAX` (optional; default `20` per worker process. Honored exactly as
  written from `1` up to a cap of `200`; invalid or non-positive values fall
  back to the default with a warning — see `parsePoolMax` in `lib/db.ts`.)
- `ARIES_EXECUTION_PROVIDER` (optional; default `hermes`)
- `ARIES_MARKETING_EXECUTION_PROVIDER` (optional; default `hermes`)
- `HERMES_GATEWAY_URL`
- `HERMES_API_SERVER_KEY` (outbound credential Aries sends to Hermes `/v1/runs`)
- `INTERNAL_API_SECRET` (required for Hermes callbacks)
- `HERMES_SESSION_KEY`
- `HERMES_RUN_TIMEOUT_MS` (optional general workflow polling timeout)
- `HERMES_POLL_INTERVAL_MS` (optional general workflow polling interval)
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

For weekly social content media generation, Hermes owns ChatGPT/OpenAI auth and provider execution. Text planning can run when media generation is disabled.

## Run
```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

### Hermes execution boundary

Compose defaults both execution selectors to Hermes:

```bash
ARIES_EXECUTION_PROVIDER=hermes
ARIES_MARKETING_EXECUTION_PROVIDER=hermes
```

Aries submits Hermes runs to `${HERMES_GATEWAY_URL}/v1/runs` with
`Authorization: Bearer ${HERMES_API_SERVER_KEY}`. Hermes must call back to
`${APP_BASE_URL}/api/internal/hermes/runs` with
`Authorization: Bearer ${INTERNAL_API_SECRET}`. Keep those secrets distinct:
`HERMES_API_SERVER_KEY` protects Aries-to-Hermes requests, while
`INTERNAL_API_SECRET` protects Hermes-to-Aries callbacks.

The general Hermes workflow adapter
currently supports the explicitly wired Hermes workflow set; marketing jobs use
the separate marketing execution port and advance through async callbacks.

### Weekly social content operational flow

1. Client submits `POST /api/social-content/jobs`.
2. Aries submits run creation to Hermes (`/v1/runs`).
3. Hermes sends authenticated callbacks to `POST /api/internal/hermes/runs`.
4. Aries updates runtime state and status read models.
5. User reviews weekly social posts/content calendar.
6. User approves optional video render/publish steps.

### Legacy gateway variables (removed)

The legacy execution gateway variables (`OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`,
`OPENCLAW_SESSION_KEY`, `LOBSTER_MEDIA_GATEWAY_ENABLED`, `LOBSTER_VIDEO_RENDER_ENABLED`,
`LOBSTER_GATEWAY_IMAGE_MODEL`, `LOBSTER_GATEWAY_VIDEO_MODEL`) have been removed.
Hermes is the sole execution provider. Remove these from any `.env` files if present.

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
  worker count aggressively on a database with tight `max_connections`. The
  value is honored exactly as written (floor `1`, cap `200`); the sidecar
  worker services in `docker-compose.yml` set `DB_POOL_MAX: 3` each and really
  get 3.
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
                        + sum(sidecar workers' DB_POOL_MAX)  # compose sets 3 each
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

Use an authenticated cookie jar for the tenant that owns the weekly social content job:

```bash
BASE_URL="https://<aries-host>"
JOB_ID="<social-content-job-id>"
COOKIE_JAR="cookies.txt"

curl -b "$COOKIE_JAR" -o /dev/null -sS \
  -w "serial: status=%{http_code} total=%{time_total}s\n" \
  "$BASE_URL/api/social-content/jobs/$JOB_ID"

seq 1 8 | xargs -I{} -P8 sh -c '
  curl -b "$0" -o /dev/null -sS \
    -w "parallel {}: status=%{http_code} total=%{time_total}s\\n" \
    "$1/api/social-content/jobs/$2"
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
    "$1/api/social-content/jobs/$2"
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
- Workflow execution is delegated through Hermes. Hermes posts idempotent run callbacks to `/api/internal/hermes/runs`, authenticated with `INTERNAL_API_SECRET`.

## Artifact stage cache directories

The pipeline writes stage artifacts (images, `.mp4` videos, review packages) to the
`$ARTIFACT_STAGE{1..4}_CACHE_DIR` paths. Because the pipeline runs on the
host while Aries runs in a container with Postgres storing only metadata, both
processes must resolve to **identical absolute paths**. Route the four cache
dirs onto the shared `ARIES_SHARED_DATA_ROOT` bind mount so `/data/...` in the
container matches `${ARIES_SHARED_DATA_ROOT}/...` on the host.

Before starting the pipeline on the host, export:

```bash
export ARTIFACT_STAGE1_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/lobster-stage1-cache"
export ARTIFACT_STAGE2_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/lobster-stage2-cache"
export ARTIFACT_STAGE3_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/lobster-stage3-cache"
export ARTIFACT_STAGE4_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/lobster-stage4-cache"
```

The container defaults to `/data/lobster-stage{N}-cache` in `docker-compose.yml`,
which equals those host paths via the `/data` bind. Override either side only
if you have a reason — if they diverge, Aries silently cannot see the files.
