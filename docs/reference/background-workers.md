# Background workers reference

Aries AI runs ten background workers. Six are sidecar Compose services. Four are in-process workers spawned by the runtime launcher. This page lists every one: its name, entry file, job, cadence, gating and config env vars, and whether it is on by default.

All ten share one image (`${ARIES_APP_IMAGE:-aries-app:local}`). The sidecars are defined in `docker-compose.yml`. The in-process workers are spawned by `scripts/start-runtime.mjs`, the container entrypoint that also boots the Next.js cluster.

## Quick map

| Worker | Type | Entry | Cadence (default) | Gate env var | On by default |
| --- | --- | --- | --- | --- | --- |
| `aries-scheduled-posts-worker` | sidecar | `scripts/automations/scheduled-posts-worker.mjs` | 60s | none | yes |
| `aries-weekly-trigger-worker` | sidecar | `scripts/automations/weekly-job-trigger-worker.ts` | 15m | `ARIES_WEEKLY_TRIGGER_ENABLED` | no |
| `aries-draft-expiry-sweep-worker` | sidecar | `scripts/automations/draft-expiry-sweep-worker.ts` | 6h | `ARIES_DRAFT_EXPIRY_ENABLED` | no |
| `aries-hermes-gc-worker` | sidecar | `scripts/automations/gc-missing-hermes-assets-worker.ts` | 6h | `ARIES_HERMES_GC_ENABLED` | no |
| `aries-insights-sync-worker` | sidecar | `scripts/automations/insights-sync-worker.ts` | 30m | none | yes |
| `aries-honcho-performance-worker` | sidecar | `scripts/automations/honcho-performance-worker.ts` | 30m | `HONCHO_WRITE_PUBLISH_ENABLED` | yes |
| stale-run reaper | in-process | `scripts/stale-run-reaper-worker.ts` | 5m | `ARIES_REAPER_ENABLED` | yes |
| hermes kanban GC | in-process | `scripts/hermes-kanban-gc-worker.ts` | 24h | `ARIES_KANBAN_GC_ENABLED` | yes |
| hermes reconciler | in-process | `scripts/hermes-reconciler-worker.ts` | 60s | `ARIES_RECONCILER_ENABLED` | yes |
| partner attribution outbox | in-process | `scripts/partner-attribution-outbox-worker.ts` | 30s | `PARTNER_ATTRIBUTION_ENABLED` | no |

"On by default" reflects the value `docker-compose.yml` ships. The reaper, kanban GC, and reconciler gates default differently in code when unset (see [In-process workers](#in-process-workers)); Compose pins each to an explicit value, so the shipped default is what the table shows.

## Sidecar services

Each sidecar is a separate `docker-compose.yml` service. All depend on `aries-app` being healthy (`condition: service_healthy`), set `restart: unless-stopped`, run on the external `docker-stack` network, and use `DB_POOL_MAX: 3`. Each worker self-schedules with `setInterval` and stays up as a long-lived process.

### aries-scheduled-posts-worker

- Command: `node scripts/automations/scheduled-posts-worker.mjs`
- What it does: Drains the `scheduled_posts` table and POSTs due rows to `/api/internal/publishing/scheduled-dispatch` on the in-network app. One replica avoids racing the SQL claim-lock.
- Cadence: 60s. `INTERVAL_MS = 60 * 1000` is hardcoded in the worker (no env override).
- Config env: `ARIES_SCHEDULED_POSTS_RUN_ONCE=1` runs a single tick then exits (skips the interval).
- Default: on. No gate.

### aries-weekly-trigger-worker

- Command: `node_modules/.bin/tsx scripts/automations/weekly-job-trigger-worker.ts`
- What it does: Starts a `weekly_social_content` job for each opted-in tenant (a `marketing_schedule` row with `enabled=true`) on its configured day/hour/timezone. POSTs to `/api/internal/marketing/weekly-trigger`.
- Cadence: 15m. `DEFAULT_INTERVAL_MS = 15 * 60 * 1000`, overridable by `ARIES_WEEKLY_TRIGGER_INTERVAL_MS` (Compose default `900000`).
- Gate: `ARIES_WEEKLY_TRIGGER_ENABLED` (Compose default `0`). When off, the worker idles instead of exiting.
- Config env: `ARIES_WEEKLY_TRIGGER_RUN_ONCE=1` runs one tick then exits.
- Default: off.

### aries-draft-expiry-sweep-worker

- Command: `node_modules/.bin/tsx scripts/automations/draft-expiry-sweep-worker.ts`
- What it does: Expires stranded pre-publish posts (no `scheduled_posts` row, never published, older than the age window) so the unscheduled-approved backlog stops growing. Talks only to Postgres.
- Cadence: 6h. `ARIES_DRAFT_EXPIRY_INTERVAL_MS` (Compose default `21600000`).
- Gate: `ARIES_DRAFT_EXPIRY_ENABLED` (Compose default `0`). When off, the worker idles.
- Config env:
  - `ARIES_DRAFT_EXPIRY_AGE_DAYS` (Compose default `14`) - age threshold for a stranded draft.
  - `ARIES_DRAFT_EXPIRY_DRY_RUN` (Compose default `0`) - when `1`, counts candidates read-only without expiring them.
  - `ARIES_DRAFT_EXPIRY_RUN_ONCE=1` runs one tick then exits.
- Default: off.

### aries-hermes-gc-worker

- Command: `node_modules/.bin/tsx scripts/automations/gc-missing-hermes-assets-worker.ts`
- What it does: Marks `creative_assets` rows orphaned once their Hermes image-cache file is evicted, so the dashboard stops emitting dead `/api/internal/hermes/media/<id>` URLs. Mounts the Hermes image cache read-only to tell "evicted" from "unreadable".
- Cadence: 6h. `ARIES_HERMES_GC_INTERVAL_MS` (Compose default `21600000`).
- Gate: `ARIES_HERMES_GC_ENABLED` (Compose default `0`). When off, the worker idles.
- Config env:
  - `ARIES_HERMES_GC_MAX_AGE_DAYS` (Compose default `7`).
  - `ARIES_HERMES_GC_DRY_RUN` (Compose default `0`).
  - `HERMES_IMAGE_CACHE_MOUNT` (default `/hermes-media`) - read-only mount the worker inspects.
  - `ARIES_HERMES_GC_RUN_ONCE=1` runs one tick then exits.
- Default: off.

### aries-insights-sync-worker

- Command: `node_modules/.bin/tsx scripts/automations/insights-sync-worker.ts`
- What it does: Syncs platform analytics (YouTube, Instagram, Facebook, and others) for every tenant with a connected `insights_account`. One replica avoids duplicate API calls.
- Cadence: 30m. `INTERVAL_MS = 30 * 60 * 1000` is hardcoded (no env override). First tick runs immediately on startup.
- Config env:
  - `ARIES_INSIGHTS_SWEEP_GRACE_MINUTES` (Compose default `60`) - grace window before a stranded `running` `insights_sync_runs` row is failed out.
  - `HONCHO_WRITE_PUBLISH_ENABLED` (Compose default `false` on this service) - gates Honcho performance writes inside the sync.
  - Per-platform insights gates, each requiring `COMPOSIO_ENABLED=true` plus the platform flag: `ARIES_X_ENABLED`, `ARIES_YOUTUBE_ENABLED`, `ARIES_REDDIT_ENABLED`, `ARIES_LINKEDIN_ENABLED` (all Compose default `false`), and `ANALYTICS_PROVIDER` (default `composio`) for the Facebook path.
- Default: on. No gate on the worker itself.

### aries-honcho-performance-worker

- Command: `npx tsx scripts/automations/honcho-performance-worker.ts`
- What it does: Reads stored `insights_post_metrics_daily` snapshots (never fetches Meta) and writes a `research_conclusion` to Honcho via `recordPerformanceEvent`. Until the #513 tables are populated, the due-posts query returns `[]` and each tick is a no-op.
- Cadence: 30m. `INTERVAL_MS = 30 * 60 * 1000` is hardcoded (no env override).
- Gate: `HONCHO_WRITE_PUBLISH_ENABLED` (Compose default `true` on this service). `recordPerformanceEvent` self-gates on this flag, so the worker stays up but writes nothing when off.
- Config env:
  - `ARIES_INSIGHTS_513_TABLES_PRESENT` (Compose default empty) - flip to `1` once `insights_post_metrics_daily` is populated.
  - `ARIES_HONCHO_PERF_RUN_ONCE=1` runs one tick then exits.
  - `HONCHO_ENABLED`, `HONCHO_BASE_URL`, `HONCHO_CONTROL_PLANE_JWT`, `HONCHO_DATA_PLANE_JWT`, `ARIES_TENANT_PSEUDONYM_SALT` configure the Honcho client.
- Default: on (the service runs; whether it writes depends on `HONCHO_WRITE_PUBLISH_ENABLED` and the #513 data).

## In-process workers

`scripts/start-runtime.mjs` spawns these four as child processes alongside the Next.js cluster, in both the `cluster` and `node` process managers. They share the runtime env. The launcher reads each gate before spawning; a worker that is not enabled is never spawned.

The launcher's gate parser (`workerGateEnabled`) treats `1`/`true`/`yes`/`on` as true and `0`/`false`/`no`/`off` as false. The two gate styles differ only in what an unset value means:

- Opt-in gates default to off when unset: `ARIES_REAPER_ENABLED`, `PARTNER_ATTRIBUTION_ENABLED`.
- Opt-out kill switches default to on when unset: `ARIES_KANBAN_GC_ENABLED`, `ARIES_RECONCILER_ENABLED`.

`docker-compose.yml` pins all four to explicit values, so the shipped defaults are as listed below.

### stale-run reaper

- Entry: `scripts/stale-run-reaper-worker.ts`
- What it does: Sweeps marketing-job runtime docs and marks stalled jobs failed. A job sitting at an approval gate is not stalled; it is reaped only after `ARIES_REAPER_AWAITING_APPROVAL_THRESHOLD_MS` (Compose default `604800000`, 7 days).
- Cadence: 5m. `DEFAULT_INTERVAL_MS = 5 * 60 * 1000`, overridable by `ARIES_REAPER_INTERVAL_MS` (Compose default `300000`).
- Gate: `ARIES_REAPER_ENABLED`. Code default when unset is off; Compose ships `1`.
- Default: on (via Compose).

### hermes kanban GC

- Entry: `scripts/hermes-kanban-gc-worker.ts`
- What it does: Archives completed kanban tasks older than the retention window, then runs downstream cleanup.
- Cadence: 24h. `DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000`, overridable by `ARIES_KANBAN_GC_INTERVAL_MS` (Compose default `86400000`).
- Gate: `ARIES_KANBAN_GC_ENABLED` (opt-out; on unless disabled). Compose ships `1`.
- Config env:
  - `ARIES_KANBAN_GC_RETENTION_DAYS` (Compose default `7`).
  - `ARIES_KANBAN_GC_RUN_ONCE=1` runs one tick then exits.
- Default: on.

### hermes reconciler

- Entry: `scripts/hermes-reconciler-worker.ts`
- What it does: The durable replacement for the in-process Hermes poll-bridge. Each interval it re-discovers in-flight marketing execution runs and ingests any Hermes has finished, via the same idempotent callback path. Runs with `APP_INSTANCE_ID=hermes-reconciler` and `DB_POOL_MAX=5`. The launcher auto-respawns it if it crashes, unless it crash-loops (5 restarts within 60s).
- Cadence: 60s. `DEFAULT_INTERVAL_MS = 60 * 1000`, overridable by `ARIES_RECONCILER_INTERVAL_MS` (Compose default `60000`). The 60s default beats the reaper's tightest stage threshold (strategy, 5 min).
- Gate: `ARIES_RECONCILER_ENABLED` (opt-out; on unless disabled). Compose ships `1`. Set to `0` to fall back to bridge-only delivery.
- Config env: `ARIES_RECONCILER_RUN_ONCE=1` runs one tick then exits.
- Default: on.

### partner attribution outbox

- Entry: `scripts/partner-attribution-outbox-worker.ts`
- What it does: Drains the partner-attribution outbox.
- Cadence: 30s. `INTERVAL_MS = 30_000` is hardcoded (no env override).
- Gate: `PARTNER_ATTRIBUTION_ENABLED` (opt-in; off unless enabled). Compose ships `false`. When off the worker is never spawned (and if launched directly, it logs and exits).
- Default: off.

## Examples

Run the scheduled-posts worker once against your configured database, then exit:

```bash
ARIES_SCHEDULED_POSTS_RUN_ONCE=1 node scripts/automations/scheduled-posts-worker.mjs
```

Dry-run the draft-expiry sweep with a 30-day age window (counts candidates, expires nothing):

```bash
ARIES_DRAFT_EXPIRY_ENABLED=1 \
ARIES_DRAFT_EXPIRY_DRY_RUN=1 \
ARIES_DRAFT_EXPIRY_AGE_DAYS=30 \
ARIES_DRAFT_EXPIRY_RUN_ONCE=1 \
node_modules/.bin/tsx scripts/automations/draft-expiry-sweep-worker.ts
```

Bring up only the always-on sidecars with Docker Compose:

```bash
docker compose up -d \
  aries-scheduled-posts-worker \
  aries-insights-sync-worker \
  aries-honcho-performance-worker
```

## Related

- [How to run and operate the background workers](../how-to/run-background-workers.md)
- [Production deployment](../DEPLOYMENT.md)
