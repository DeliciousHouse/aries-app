# Aries AI — Production Deployment

## Overview

Production deployment uses Docker and GitHub Actions. The GitHub Actions Deploy workflow builds and publishes `ghcr.io/delicioushouse/aries-app:<sha>` for each commit to `master`, then a self-hosted deploy host pulls the pinned image and force-recreates the live `aries-app` container.

## Docker image

The `Dockerfile` uses a multi-stage build:

1. **`deps`** — `npm ci` against `package.json`
2. **`builder`** — copies source and runs `npm run build` (Next.js production build)
3. **`runner`** — Node 24 Bookworm; copies only the built output, production `node_modules`, and scripts; runs as non-root `node` user (UID/GID configurable via build args `ARIES_NODE_UID` / `ARIES_NODE_GID`)

Application code is baked into the image at `/app`. Writable runtime artifacts live under `/data` only.

## Environment setup

Copy and fill in the environment template:

```bash
cp .env.example .env
```

The following variables are required for production:

```
APP_BASE_URL                 # Public-facing URL, e.g. https://aries.example.com
INTERNAL_API_SECRET          # Inbound Hermes callback bearer token
HERMES_GATEWAY_URL           # Hermes gateway base URL
HERMES_API_SERVER_KEY        # Outbound Hermes bearer token
HERMES_SESSION_KEY           # Hermes session identifier
DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
NEXTAUTH_URL / AUTH_URL / NEXTAUTH_SECRET / AUTH_TRUST_HOST
OAUTH_TOKEN_ENCRYPTION_KEY   # Required for Aries-managed OAuth providers
```

See `SELF_HOSTING.md` for the full variable reference and optional variables.

## Docker Compose production run

Create the external Docker network if it does not exist:

```bash
docker network create docker-stack || true
```

Start the app:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml up --build -d aries-app
```

`docker-compose.yml` publishes `${PORT:-3000}` on the host. `docker-compose.local.yml` layers in localhost-friendly URL defaults and is included for both local and production-style local runs.

View logs:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml logs -f aries-app
```

Stop:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml down
```

## GitHub Actions release flow

Production deploys are triggered automatically on `master` pushes via `.github/workflows/deploy.yml`. The workflow runs on a `self-hosted, Linux, X64` runner and:

1. Validates the deploy target branch.
2. Builds and publishes `ghcr.io/delicioushouse/aries-app:<sha>` to GHCR.
3. Pulls the pinned image on the deploy host.
4. Force-recreates the `aries-app` service and waits for it to pass a health check (failure here fails the deploy).
5. Force-recreates every worker sidecar in `docker-compose.yml` (`aries-scheduled-posts-worker`, `aries-weekly-trigger-worker`, `aries-draft-expiry-sweep-worker`, `aries-hermes-gc-worker`, `aries-feedback-retry-worker`, `aries-insights-sync-worker`, `aries-honcho-performance-worker`, `aries-composio-reconciler-worker`) onto the same pinned image. Sidecar recreate failures are non-fatal relative to the app deploy.
6. Verifies each sidecar has a running container on the target image ID, iterating `docker compose config --services` so the list can never drift from `docker-compose.yml`. Mismatches stay non-fatal but surface as GitHub `::warning::` annotations and step-summary lines.

Every service in `docker-compose.yml` must have a matching force-recreate block in the workflow: `tests/deploy-manifest-parity.test.ts` (run in `npm run verify` and CI) fails when a compose service is added, renamed, or removed without the workflow being updated. This closes the gap where a worker added to compose but omitted from the workflow would keep running a stale image across every deploy (its `restart: unless-stopped` container is never re-pulled).

Manual dispatch with an explicit image tag:

```bash
gh workflow run Deploy --ref master \
  -f image_tag=<full-commit-sha> \
  -f git_ref=<full-commit-sha>
```

## Process model and tuning

The production container starts with `node scripts/start-runtime.mjs`. By default it uses Node cluster mode with 2 workers.

| Variable | Default | Purpose |
|---|---|---|
| `ARIES_PROCESS_MANAGER` | `cluster` | Set `node` for single-process rollback |
| `ARIES_WEB_CONCURRENCY` | `2` | Worker count; accepts a positive integer or `max` |
| `ARIES_WORKER_MAX_RESTARTS` | `5` | Per-worker crash restart cap before container exit |
| `DB_POOL_MAX` | `20` (app workers); compose sets `3` per sidecar | PostgreSQL connections per process; strictly-parsed integer honored from 1–200. Sidecars' dedicated pools fall back to `3` when unset; the insights-sync sidecar uses the shared `lib/db` pool (fallback `20`), so the compose-set `3` is what governs |
| `PORT` | `3000` | Listening port |

Total possible PostgreSQL connections ≈ `ARIES_WEB_CONCURRENCY × DB_POOL_MAX + 5` (the Hermes reconciler child pinned at 5 in `scripts/start-runtime.mjs`) plus the sum of each sidecar worker's own `DB_POOL_MAX` (compose sets 3 per sidecar; the honcho worker may additionally open the shared `lib/db` pool, so budget 2× its value). Lower `DB_POOL_MAX` before raising worker count on databases with tight `max_connections`.

Example for a 4-worker deploy with smaller connection pools (suitable for ~50 users if the database can spare ~40 app connections):

```bash
ARIES_WEB_CONCURRENCY=4 DB_POOL_MAX=10 \
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml up -d
```

## Health checks

| Endpoint | Purpose |
|---|---|
| `GET /` | Container liveness |
| `GET /api/health/db` | Returns `{ status, poolStats, roundTripMs }`; use as the load-balancer readiness probe |

## Data persistence

The container stores generated runtime artifacts under `/data`, bind-mounted from `${ARIES_SHARED_DATA_ROOT:-/home/node/data}` on the host. Ensure this directory is backed up or persisted across container replacements.

## Side processes

Three background side-processes run inside each container:

- **Stale-run reaper** (`ARIES_REAPER_ENABLED=1`): marks stuck marketing jobs `failed_stale` every `ARIES_REAPER_INTERVAL_MS` ms (default 5 minutes).
- **Hermes kanban GC** (`ARIES_KANBAN_GC_ENABLED=1`): archives completed Hermes kanban tasks older than `ARIES_KANBAN_GC_RETENTION_DAYS` days every `ARIES_KANBAN_GC_INTERVAL_MS` ms (default 24 hours).
- **Hermes run reconciler** (`ARIES_RECONCILER_ENABLED=1`): Hermes `/v1/runs` is a polled API that never calls back, so this standing worker re-discovers in-flight marketing runs every `ARIES_RECONCILER_INTERVAL_MS` ms (default 60 seconds) and ingests any Hermes has finished, through the same idempotent callback path. It replaces the unreliable in-process poll-bridge; its 60s sweep beats the reaper's tightest stage threshold so finished creative is ingested before a job can be reaped.

Set any of these variables to `0` to disable the corresponding side-process.

## Hermes gateway wiring

The Hermes execution boundary requires two distinct secrets:

- `HERMES_API_SERVER_KEY` — outbound credential Aries sends to Hermes on `POST /v1/runs`
- `INTERNAL_API_SECRET` — inbound credential Hermes sends back to Aries on `POST /api/internal/hermes/runs`

These must not be the same value. Hermes must be configured to post callbacks to `${APP_BASE_URL}/api/internal/hermes/runs` with `Authorization: Bearer ${INTERNAL_API_SECRET}`.

For multi-profile deployments (research / strategist / content-generator), set the per-profile gateway vars. Leave them blank to route all stages through the single `HERMES_GATEWAY_URL`:

```
HERMES_STRATEGIST_GATEWAY_URL=http://host:8654
HERMES_CONTENT_GATEWAY_URL=http://host:8655
```

## Development container

`docker-compose.local.yml` defines an `aries-app-dev` service behind the `dev` profile. Its default command is `npm run dev`, which already includes `--turbopack` (required for Tailwind CSS v4), so no command override is needed:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml \
  run --rm --service-ports aries-app-dev
```
