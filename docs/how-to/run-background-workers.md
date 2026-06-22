# How to run and operate the background workers

Run Aries' background automation, enable the opt-in workers, dry-run the draft-expiry sweep, and confirm a worker is actually doing work.

Aries runs background jobs in two places: workers spawned inside the app container by `scripts/start-runtime.mjs`, and standalone sidecar workers that run as their own Docker Compose services. This guide covers the operator tasks. For the per-worker field-by-field breakdown, see the [background workers reference](../reference/background-workers.md).

## Prerequisites

- Shell access to the host running `docker compose`, in the repo root (where `docker-compose.yml` lives).
- The app image built and the `aries-app` service running and healthy. Every sidecar declares `depends_on: aries-app condition: service_healthy`, so a sidecar will not start until `aries-app` reports healthy.
- A `.env` file (or exported environment) loaded by Compose. The worker gates and intervals below are read from there.
- For workers that call back into the app (`aries-scheduled-posts-worker`, `aries-weekly-trigger-worker`): `INTERNAL_API_SECRET` set. Those workers authenticate to the app's internal routes with `Authorization: Bearer ${INTERNAL_API_SECRET}`. (`aries-honcho-performance-worker` does not call the app; it writes to Honcho directly via `recordPerformanceEvent`.)

## Background, in one paragraph

The `aries-app` container starts with `scripts/start-runtime.mjs`. It first runs `scripts/init-db.js` synchronously (idempotent `CREATE/ALTER ... IF NOT EXISTS`); if init-db exits non-zero, start-runtime calls `process.exit(1)` and refuses to fork anything. It then forks the Next.js runtime plus four in-process sibling workers, each behind its own env gate:

| In-process worker | Gate | Default |
| --- | --- | --- |
| partner-attribution-outbox | `PARTNER_ATTRIBUTION_ENABLED` | OFF (opt-in, compose `:-false`) |
| stale-run-reaper | `ARIES_REAPER_ENABLED` | ON in compose (`:-1`) |
| hermes-kanban-gc | `ARIES_KANBAN_GC_ENABLED` | ON (opt-out, compose `:-1`) |
| hermes-reconciler | `ARIES_RECONCILER_ENABLED` | ON (opt-out, compose `:-1`) |

Separately, six sidecar Compose services run the same app image with a different `command`:

| Service | Command | Default state | Cadence |
| --- | --- | --- | --- |
| `aries-scheduled-posts-worker` | `node scripts/automations/scheduled-posts-worker.mjs` | Always on | every 60s (hardcoded) |
| `aries-weekly-trigger-worker` | `node_modules/.bin/tsx scripts/automations/weekly-job-trigger-worker.ts` | OFF (`ARIES_WEEKLY_TRIGGER_ENABLED:-0`) | every 15m |
| `aries-draft-expiry-sweep-worker` | `node_modules/.bin/tsx scripts/automations/draft-expiry-sweep-worker.ts` | OFF (`ARIES_DRAFT_EXPIRY_ENABLED:-0`) | every 6h |
| `aries-hermes-gc-worker` | `node_modules/.bin/tsx scripts/automations/gc-missing-hermes-assets-worker.ts` | OFF (`ARIES_HERMES_GC_ENABLED:-0`) | every 6h |
| `aries-insights-sync-worker` | `node_modules/.bin/tsx scripts/automations/insights-sync-worker.ts` | Always on | every 30m (hardcoded) |
| `aries-honcho-performance-worker` | `npx tsx scripts/automations/honcho-performance-worker.ts` | Ledger writes ON (`HONCHO_WRITE_PUBLISH_ENABLED:-true`) | every 30m (hardcoded) |

Gate parsing (`workerGateEnabled` in `start-runtime.mjs`) treats `1/true/yes/on` as truthy and `0/false/no/off` as falsy. Anything unset or unrecognized falls back to that gate's shipped default.

## Steps

### 1. Bring up the app and all workers

Start the stack. Compose starts `aries-app`, waits for it to be healthy, then starts each sidecar.

```bash
docker compose up -d
```

Expected result: `docker compose ps` lists `aries-app` plus the six sidecar services, all `running`. Sidecars whose gate is off still run; they idle rather than exit (see step 4).

### 2. Enable an opt-in sidecar worker via its env gate

The opt-in sidecars ship dormant. To enable one, set its gate to a truthy value and recreate the service. Example for the weekly trigger:

```bash
# In your .env (or environment):
ARIES_WEEKLY_TRIGGER_ENABLED=1
```

```bash
docker compose up -d aries-weekly-trigger-worker
```

The same pattern enables the other opt-in workers:

- Draft-expiry sweep: `ARIES_DRAFT_EXPIRY_ENABLED=1`, then recreate `aries-draft-expiry-sweep-worker`.
- Hermes asset GC: `ARIES_HERMES_GC_ENABLED=1`, then recreate `aries-hermes-gc-worker`.

Expected result: the service logs a `starting;` line instead of the `idling` line. The gate is read once at process start, so you must recreate (not just edit `.env`) for a change to take effect.

### 3. Enable or disable an in-process worker

The in-process workers live inside `aries-app`, so changing their gate means recreating `aries-app`. For example, to turn on the partner-attribution outbox (off by default):

```bash
# In your .env:
PARTNER_ATTRIBUTION_ENABLED=true
```

```bash
docker compose up -d aries-app
```

To switch off one of the opt-out workers (reaper, kanban-gc, reconciler), set its gate to a falsy value, for example `ARIES_RECONCILER_ENABLED=0`, then recreate `aries-app`.

Expected result: start-runtime forks (or skips) the matching worker on the next boot. The hermes-reconciler auto-respawns on crash, with a crash-loop guard that stops restarting after 5 restarts within 60000ms.

### 4. Dry-run the draft-expiry sweep

Before letting the sweep delete anything, run it read-only. `ARIES_DRAFT_EXPIRY_DRY_RUN=1` makes every tick issue only count queries through `runDraftExpirySweep(pool, { dryRun, ageDays })` in `backend/marketing/draft-expiry-sweep.ts`; it writes nothing. The sweep talks directly to Postgres, so it needs no app round-trip.

To run one read-only cycle and exit, combine dry-run with one-shot mode:

```bash
docker compose run --rm \
  -e ARIES_DRAFT_EXPIRY_ENABLED=1 \
  -e ARIES_DRAFT_EXPIRY_DRY_RUN=1 \
  -e ARIES_DRAFT_EXPIRY_RUN_ONCE=1 \
  aries-draft-expiry-sweep-worker
```

Expected result: a startup line, then a summary line, then the process exits. The summary reports `dry_run`, `age_days`, `cutoff`, `candidates`, `expired`, `batches`, `truncated`, and `top_tenants`:

```
[draft-expiry-sweep-worker] starting; interval=...ms age_days=14 dry_run=true
[draft-expiry-sweep-worker] summary {"dry_run":true,"age_days":14,"cutoff":"...","candidates":N,"expired":0,...}
```

In dry-run, `candidates` shows how many drafts would expire and `expired` stays `0`. Tune the age window with `ARIES_DRAFT_EXPIRY_AGE_DAYS` (default `14`). When you are satisfied, set `ARIES_DRAFT_EXPIRY_DRY_RUN=0` and `ARIES_DRAFT_EXPIRY_ENABLED=1` and recreate the long-running service to commit deletions on the 6h interval (`ARIES_DRAFT_EXPIRY_INTERVAL_MS`, default `21600000`).

Other workers expose the same one-shot escape hatch: `ARIES_SCHEDULED_POSTS_RUN_ONCE=1`, `ARIES_WEEKLY_TRIGGER_RUN_ONCE=1`, `ARIES_HONCHO_PERF_RUN_ONCE=1`.

## Verification

Confirm a worker is doing work, not just running.

### Check startup vs idle log lines

Each sidecar logs one line at startup. An enabled worker logs `starting;`; a gated-off worker logs `idling`.

```bash
docker compose logs --tail=50 aries-scheduled-posts-worker
docker compose logs --tail=50 aries-weekly-trigger-worker
docker compose logs --tail=50 aries-draft-expiry-sweep-worker
```

Enabled examples:

```
[scheduled-posts-worker] starting; interval=60000ms batch=50
[weekly-trigger-worker] starting; interval=900000ms
[draft-expiry-sweep-worker] starting; interval=21600000ms age_days=14 dry_run=false
```

Idle examples (gate off):

```
[weekly-trigger-worker] ARIES_WEEKLY_TRIGGER_ENABLED is off; idling (no work). Set the flag and restart to enable.
[draft-expiry-sweep-worker] ARIES_DRAFT_EXPIRY_ENABLED is off; idling (no work). Set the flag and restart to enable.
```

### Check per-tick summary lines

Workers log a summary only when a tick did something, so an empty queue produces no summary line. Watch the logs live:

```bash
docker compose logs -f aries-scheduled-posts-worker
```

- `aries-scheduled-posts-worker`: `summary {processed,dispatched,failed,skipped}` when `processed` or `failed` > 0.
- `aries-weekly-trigger-worker`: `summary {scanned,due,claimed,started,skipped,failed}` when `claimed` or `failed` > 0.
- `aries-draft-expiry-sweep-worker`: `summary {dry_run,age_days,cutoff,candidates,expired,batches,truncated,top_tenants}` when there are candidates, expirations, or truncation.
- `aries-honcho-performance-worker`: `summary {tenantsScanned,due,written,...,failed}` when `due` or `failed` > 0.
- `aries-insights-sync-worker`: emits newline-delimited JSON events every tick, for example `{"event":"insights_sync_start",...}`, `insights_sync_account`, `insights_sync_done`, and `insights_sync_noop` when no accounts are connected.

### Check the database for evidence of work

```bash
docker compose exec aries-app sh -c \
  'PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT dispatch_status, count(*) FROM scheduled_posts GROUP BY 1;"'
```

Expected result: as the scheduled-posts worker runs, rows move through the `dispatch_status` enum `pending -> in_flight -> dispatched` (or `failed`). Insights runs are recorded in `insights_sync_runs`.

## Troubleshooting

**Sidecars never start.** They wait on `aries-app` being healthy (`depends_on ... condition: service_healthy`). Run `docker compose ps`; if `aries-app` is `starting` or `unhealthy`, fix it first. Check `docker compose logs aries-app`.

**`aries-app` exits at boot with an init-db error.** start-runtime runs `scripts/init-db.js` before forking workers; on a non-zero exit it logs `[runtime] init-db.js exited with code=...; refusing to start workers` and exits 1. Read the init-db output, fix the database (connectivity, permissions, migrations), and restart. To boot without the schema step (for example when init already ran), set `ARIES_SKIP_DB_INIT=1`.

**`aries-app` refuses to start with an `ARIES_PROCESS_MANAGER` error.** The value must be `cluster` (default, `:-cluster`) or `node`. Any other value makes start-runtime log `Invalid ARIES_PROCESS_MANAGER value ...` and exit 1.

**You enabled a gate but nothing changed.** Gates are read once at process start. Editing `.env` is not enough; you must recreate the service (`docker compose up -d <service>`). For in-process workers, recreate `aries-app`. Also confirm the value is a recognized truthy token (`1/true/yes/on`); unrecognized values fall back to the gate's default.

**A worker that calls the app logs auth or 401 errors.** `aries-scheduled-posts-worker` and `aries-weekly-trigger-worker` POST to internal routes (`/api/internal/publishing/scheduled-dispatch`, `/api/internal/marketing/weekly-trigger`) with `Authorization: Bearer ${INTERNAL_API_SECRET}`. Make sure `INTERNAL_API_SECRET` matches the value the app expects, and that `APP_BASE_URL` resolves to `http://aries-app:${PORT:-3000}`.

**The honcho-performance worker runs but writes nothing.** The worker still ticks regardless; `recordPerformanceEvent` self-gates and skips the ledger when writes are off. To actually write, you need `HONCHO_WRITE_PUBLISH_ENABLED=true` (the service default) and `HONCHO_ENABLED=true`, plus `HONCHO_BASE_URL`, both Honcho JWTs (`HONCHO_CONTROL_PLANE_JWT`, `HONCHO_DATA_PLANE_JWT`), and `ARIES_TENANT_PSEUDONYM_SALT`. If any are missing, writes silently no-op.

**Insights-sync logs `insights_sync_noop`.** That means no connected accounts for the tenants scanned. Per-provider syncs (X, YouTube, Reddit, LinkedIn) are sub-gated by their own `ARIES_*_ENABLED` plus `COMPOSIO_ENABLED`; if a provider is off, that adapter stays dormant.

**The reconciler keeps restarting, then stops.** The hermes-reconciler auto-respawns on crash but gives up after 5 restarts within 60000ms, logging `crashed Nx within ...ms; not restarting (crash loop). Restart the container after fixing.` Fix the underlying error (often an import or config failure visible just above), then recreate `aries-app`.

## Related

- [Background workers reference](../reference/background-workers.md)
- [Production deployment](../DEPLOYMENT.md)
