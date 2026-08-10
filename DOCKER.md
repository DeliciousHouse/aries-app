# Aries App Containerization

## Files
- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.local.yml`
- `docker-compose.selfhost.yml`
- `.dockerignore`

## Deployment contract
- Application code is baked into the image and mounted internally at `/app`.
- Writable runtime data lives under `/data` only.
- Production Compose mounts `/data` from `${ARIES_SHARED_DATA_ROOT:-/home/node/data}` so generated artifacts survive container replacement.
- Source bind mounts are development-only.

## Production release

For `aries-app`, deploy by merging or pushing to `master`. The GitHub Actions Deploy workflow builds and publishes `ghcr.io/delicioushouse/aries-app:<sha>` for the exact target commit, then the self-hosted deploy host starts the pinned `aries-autoheal` external sidecar, pulls that pinned app image, force-recreates the `aries-app` service, and — once the app passes its health check — force-recreates every app-image worker sidecar in `docker-compose.yml` onto the same pinned image. A post-deploy check then verifies each app-image sidecar has a running container on the target image ID; sidecar failures are non-fatal to the deploy but surface as GitHub `::warning::` annotations and step-summary lines. `tests/deploy-manifest-parity.test.ts` (in `npm run verify` and CI) fails when an app-image compose service is added without a matching recreate block in the workflow.

Manual deploys still use workflow dispatch with an explicit image tag. Use the full commit SHA for normal production recovery so the workflow can build and verify the exact image before restart:

```bash
gh workflow run Deploy --ref master \
  -f image_tag=<full-commit-sha> \
  -f git_ref=<full-commit-sha>
```

### Boot resilience and unhealthy-container recovery

The production instrumentation hook probes the configured Hermes gateway's
`/health` and `/v1/capabilities` endpoints. It retries a boot-time failure three
times with 1-second and 2-second backoff only for transport/timeouts, HTTP 408/429,
and 5xx responses. A still-unavailable gateway is logged as degraded startup state
and does not prevent the web app from serving. Bad credentials, other 4xx responses,
an incompatible/missing capability contract, static configuration errors, and
unrelated startup exceptions still fail fast.

Docker restart policies do not restart a running container merely because its
healthcheck becomes `unhealthy`. The base Compose file therefore labels only
`aries-app` with `com.delicioushouse.aries.autoheal=true`. The `aries-autoheal`
watcher uses the immutable `willfarrell/autoheal:1.2.0@sha256:31f580ef0279eaced5b38d631b08c474d70d8403c1c2fdd6ddcf2e879d5f3f7c`
manifest and the in-repo `scripts/aries-autoheal.sh` policy. It allows at most three
successful restarts per container in 15 minutes; further checks leave the
container unhealthy and emit one operator-visible error until the window expires.
Restart history lives in the `aries-autoheal-state` volume, so restarting the
watcher does not reset the budget. The deploy workflow starts and verifies the
watcher before recreating the web container.

The watcher needs read/write access to `/var/run/docker.sock` to issue a restart,
which is effectively host-level Docker control. Its Docker query requires both the
unhealthy state and the full Aries-specific label key/value; no worker sidecars or
unrelated Compose stacks are opted in.

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
- `DB_POOL_MAX` (optional; default `20` per app worker process. The sidecars'
  dedicated worker pools fall back to `3` when unset (`lib/db-pool-config.ts`),
  except the insights-sync sidecar, which uses the shared `lib/db` pool
  (fallback `20`) — docker-compose explicitly sets `DB_POOL_MAX: 3` on every
  sidecar service, and that compose value is what governs in practice.
  Strictly parsed: an explicit integer is honored as written from `1` up to a
  cap of `200`; anything else — `0`, `1e2`, `3garbage` — falls back to the
  caller's default with a warning. See `parsePoolMax` in
  `lib/db-pool-config.ts`.)
- `ARIES_EXECUTION_PROVIDER` (optional; default `hermes`)
- `ARIES_MARKETING_EXECUTION_PROVIDER` (optional; default `hermes`)
- `HERMES_GATEWAY_URL`
- `HERMES_API_SERVER_KEY` (outbound credential Aries sends to Hermes `/v1/runs`)
- `INTERNAL_API_SECRET` (required for Hermes callbacks)
- `HERMES_SESSION_KEY`
- `ARIES_HERMES_NETWORK_HEALTHCHECK_ENABLED` (optional; default `1` — make the
  app container unhealthy when the configured Hermes `/health` is unreachable;
  the installer sets `0` for an explicit `--no-hermes` deployment)
- `ARIES_HERMES_CLI_COMPAT_ENABLED` (temporary; default `1` — retains only the
  in-image `hermes kanban gc` maintenance path during sidecar cutover)
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

### Optional production Hermes sidecar

`docker-compose.yml` includes `aries-hermes` behind the `hermes-sidecar` profile.
It uses the official Hermes Agent v0.20.0 (`v2026.8.3`) image pinned by manifest
digest, mounts `${ARIES_HERMES_DATA_ROOT:-/home/node/.hermes}` at `/opt/data`, and
shares the `docker_stack` network with Aries. Existing external gateways remain
the default until an operator activates the profile.

For a controlled cutover, first stop the host Hermes gateway that owns the same
data directory, then persist all four stage URLs in the Compose `.env` and start
the sidecar. The exports below are the equivalent one-invocation smoke command:

```bash
export HERMES_GATEWAY_URL=http://aries-hermes:8642
export HERMES_RESEARCH_GATEWAY_URL=http://aries-hermes:8642
export HERMES_STRATEGIST_GATEWAY_URL=http://aries-hermes:8642
export HERMES_CONTENT_GATEWAY_URL=http://aries-hermes:8642
docker compose --profile hermes-sidecar up -d aries-hermes aries-app
```

Do not run host and container gateways concurrently against the same Hermes data
directory. Verify `aries-hermes` and `aries-app` are healthy before setting
`ARIES_HERMES_CLI_COMPAT_ENABLED=0`; the follow-up activation task owns that
production switch and rollback.

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
  `ARIES_WEB_CONCURRENCY * DB_POOL_MAX` plus 5 for the Hermes reconciler child
  (pinned via `DB_POOL_MAX: '5'` in `scripts/start-runtime.mjs`), so lower
  `DB_POOL_MAX` before raising worker count aggressively on a database with
  tight `max_connections`. The value is honored exactly as written (floor `1`,
  cap `200`); the sidecar worker services in `docker-compose.yml` set
  `DB_POOL_MAX: 3` each and really get 3. Do not set the app container's value
  to a tiny number like `1` — one slow query would monopolize a web worker's
  only connection and stall its requests.
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
total_app_connections = containers * (ARIES_WEB_CONCURRENCY * DB_POOL_MAX + 5)
                        + sum(sidecar workers' DB_POOL_MAX)
# +5 per app container = the Hermes reconciler child (scripts/start-runtime.mjs)
# sidecars: compose sets DB_POOL_MAX: 3 each; the honcho worker can additionally
# instantiate the shared lib/db pool via its backend imports (budget 2x for it)
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

### Authenticated /insights profile (S7-1)

The command above measures only the two PUBLIC paths. The real 50-user cost is
`/insights`, because one page open fans out to ~10 concurrent section queries —
which is exactly the pool pressure this check exists to find.

Those paths are gated, so the harness needs a session. **Do not simply append
`/insights` to an unauthenticated run:** the page answers with a redirect to
`/login`, and the harness would then be measuring the login page rather than the
dashboard. It refuses to run gated paths without a session for that reason.

```bash
# 1. Mint a session for the pinned QA sandbox identity (12h TTL cap).
npx tsx scripts/qa/mint-qa-session.ts --out /tmp/qa-cookies.json --ttl-minutes 60

# 2. Run the authenticated profile: public paths + /insights + every section endpoint.
SCALE_SMOKE_BASE_URL="$BASE_URL" \
SCALE_SMOKE_AUTHED=1 \
SCALE_SMOKE_COOKIE_FILE=/tmp/qa-cookies.json \
npm run smoke:scale50
```

Every request must return a real `200`. A redirect, a `403`, or anything other
than the expected status fails the run.

**Capture a baseline before tuning anything.** Later performance work is accepted
by re-running against this file, so it has to be captured first:

```bash
SCALE_SMOKE_BASE_URL="$BASE_URL" SCALE_SMOKE_AUTHED=1 \
SCALE_SMOKE_COOKIE_FILE=/tmp/qa-cookies.json \
npm run smoke:scale50 -- --baseline-out docs/perf/insights-baseline.json

# ...after a change, compare against it:
SCALE_SMOKE_BASE_URL="$BASE_URL" SCALE_SMOKE_AUTHED=1 \
SCALE_SMOKE_COOKIE_FILE=/tmp/qa-cookies.json \
npm run smoke:scale50 -- --baseline docs/perf/insights-baseline.json
```

A p95 more than 25% above baseline (and at least 100ms worse, so a fast endpoint
does not trip on jitter) fails the run. A path with no baseline entry is
reported as uncompared rather than passing silently. Comparing against a
baseline captured at a **different concurrency** is refused outright — latency
scales with load, so those numbers cannot be compared.

> **Capture the baseline against this container profile, never against
> `npm run dev`.** A dev server recompiles on demand and shares the machine with
> whatever else is running: measured against one, three consecutive *no-change*
> runs failed on three different paths (`/` swinging 609→791ms, `/api/health/db`
> 40→190ms). Those swings are the environment, not the code, and a baseline
> taken there would make every later comparison meaningless. Run the container
> profile, let it settle, then capture.

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
export ARTIFACT_STAGE1_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/hermes-stage1-cache"
export ARTIFACT_STAGE2_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/hermes-stage2-cache"
export ARTIFACT_STAGE3_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/hermes-stage3-cache"
export ARTIFACT_STAGE4_CACHE_DIR="${ARIES_SHARED_DATA_ROOT:-/home/node/data}/hermes-stage4-cache"
```

The container defaults to `/data/hermes-stage{N}-cache` in `docker-compose.yml`,
which equals those host paths via the `/data` bind. Override either side only
if you have a reason — if they diverge, Aries silently cannot see the files.

## Insights activation profile (analytics + comments)

The insights pipeline — account metrics, post metrics, comments, and comment
classification — is **dormant on a fresh deploy**. Nothing is broken; it is
gated off by default. This section records exactly which variables turn it on
and which service needs each, because they exist only as host-`.env`
passthroughs in `docker-compose.yml` and are otherwise undocumented.

### The one blocker

`COMPOSIO_ENABLED` defaults to `false` in **three** places
(`aries-app`, `aries-insights-sync-worker`, `aries-composio-reconciler-worker`).
`ANALYTICS_PROVIDER` already defaults to `composio` in both compose and code, so
`COMPOSIO_ENABLED=false` is the only default-deploy blocker for the Facebook
insights path. Setting `ANALYTICS_PROVIDER=direct_meta` explicitly disables that
path instead.

### Minimum host `.env` to activate

```bash
COMPOSIO_ENABLED=true
COMPOSIO_API_KEY=<composio api key>
# Provider auth configs — at minimum the ones you actually connect:
COMPOSIO_DEFAULT_AUTH_CONFIG_ID=<id>
COMPOSIO_FACEBOOK_AUTH_CONFIG_ID=<id>
COMPOSIO_INSTAGRAM_AUTH_CONFIG_ID=<id>
```

`ANALYTICS_PROVIDER` needs no entry unless you are opting out (`direct_meta`).

### Which service needs what

| Variable | `aries-app` | `aries-insights-sync-worker` | Notes |
| --- | --- | --- | --- |
| `COMPOSIO_ENABLED` | yes | yes | must be `true` on **both**; the worker executes Composio tools itself |
| `COMPOSIO_API_KEY` | yes | yes | same key both places |
| `COMPOSIO_*_AUTH_CONFIG_ID` | yes (all 9 providers) | 6: `DEFAULT`, `FACEBOOK`, `X`, `YOUTUBE`, `REDDIT`, `LINKEDIN` | the app owns the connect flow; the worker gets the providers it can pull insights for. Note the worker has **no** `INSTAGRAM` or `METAADS` entry — IG insights resolve through the Facebook/default config |
| `ANALYTICS_PROVIDER` | — | yes | defaults to `composio` |
| `HERMES_GATEWAY_URL` / `HERMES_API_SERVER_KEY` | yes | yes | the worker needs them for comment classification — **and, when the URL is host-scoped, the `extra_hosts` mapping below** |
| `ARIES_COMMENT_CLASSIFICATION_ENABLED` | — | yes (**ships `1`**) | see the trap below |
| `ARIES_INSIGHTS_SWEEP_GRACE_MINUTES` | — | yes (default `60`) | stranded `running` sync-run sweep |
| `COMPOSIO_FACEBOOK_POST_INSIGHTS_ACTION` | — | optional | verified code default; set only to override |

`DB_POOL_MAX` is pinned to `3` on the sidecar — see the connection-budget
section above before changing it.

### The host-gateway trap

The Hermes gateway is a **host process** listening on `0.0.0.0:8642` — not a
compose service. `HERMES_GATEWAY_URL` is therefore
`http://host.docker.internal:8642`, and that name only resolves inside a
container that carries

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

That mapping was declared on `aries-app` only. `aries-insights-sync-worker` got
the gateway URL and key but not the mapping, so every comment-classification
call from the sidecar failed with `getaddrinfo ENOTFOUND host.docker.internal`
— logged as `classifyComments: unreachable (fetch failed)` on every tick that
had unclassified comments, and **zero** rows in
`insights_comment_classifications`, ever. Fixed 2026-08-10; the env pair and the
mapping must be kept together on any service that talks to a host-scoped
gateway.

**Verification signal.** The worker emits one NDJSON line per container start:

```bash
docker logs --since 3m aries-insights-sync-worker | grep insights_classifier_preflight
```

| field | meaning |
| --- | --- |
| `"ok":true` | reachable (any HTTP response counts, including 404) |
| `"reason":"unreachable"` | DNS/network — check `extra_hosts` and that the gateway is listening |
| `"reason":"unauthorized"` | reached it; the worker's `HERMES_API_SERVER_KEY` does not match the gateway's |
| `"reason":"not_configured"` | URL or key missing from this service's env |
| `"reason":"disabled"` | `ARIES_COMMENT_CLASSIFICATION_ENABLED` is off |

The probe is a single bounded GET, non-fatal, and never blocks the first tick.
Every `unreachable` failure detail — preflight or live — now also names the
gateway `host:port` it could not reach.

### The empty-default trap

`ARIES_COMMENT_CLASSIFICATION_ENABLED` ships **ON** (`:-1`) on the sync worker.
With the flag on but `HERMES_GATEWAY_URL` / `HERMES_API_SERVER_KEY` missing from
that service's environment, any sync run that has unclassified comments in its
batch window reports `not_configured` and downgrades to `partial` — deliberately
loud rather than silent. The other legs still persist. Runs with nothing to
classify stay `ok`, so a misconfigured deploy can look healthy until the first
comment arrives.

Without classification the comments still land in `insights_comments`, but
`insights_comment_classifications` stays empty — which surfaces as
`0% positive` in Conversations, an empty "What people are asking" panel, and a
`lead_generation` goal count of 0. There is no other production classifier.

### Verifying activation

```bash
docker compose exec aries-app node -e "console.log(process.env.COMPOSIO_ENABLED)"
docker compose exec aries-insights-sync-worker node -e "console.log(process.env.COMPOSIO_ENABLED, !!process.env.HERMES_API_SERVER_KEY)"
docker compose logs --tail=50 aries-insights-sync-worker
```

Then confirm a clean tick in the database: one `insights_sync_runs` row per
tenant per interval with `status='ok'` (or `partial` plus a populated
`error_message` naming the failed leg). A tenant only syncs when it has a
connected `insights_accounts` row.
