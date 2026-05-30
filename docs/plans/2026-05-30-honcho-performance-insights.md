# Honcho performance-insights integration — feed real Meta post metrics into brand memory

**Status:** Ready to build (supersedes the 2026-05-24 draft, which has stale call-site/type references).
**Author:** Staff eng, 2026-05-30, master @ v0.1.13.15.
**Supersedes:** `docs/plans/2026-05-24-honcho-performance-insights-integration.md` (kept for history; corrections noted in Current State).

---

## Context

Aries already writes to Honcho on the publish-stage Hermes callback (`scheduleHermesPublishPerformanceHonchoWrite`), but the payload is **whatever Hermes happened to return in its publish-stage output** — there is no back-fetch of *actual* Meta performance after a post has been live. Honcho learns "we published X", never "X got 300 likes vs Y got 50." The brand-memory loop is open: the marketing pipeline can't learn from real-world performance because real-world performance never reaches Honcho.

This epic closes that loop: 24–72h (and 7d / 30d terminal) after publish, fetch the post's real Meta `/insights` metrics, scrub platform IDs, and write a `research_conclusion` to the `peer-market-signal-<topicPseudonym>` Honcho peer via the **already-shipped** `recordPerformanceEvent` path.

**This is NOT the analytics dashboard.** Issue #513 builds the operator-facing dashboard (Meta posts/account/story insights, `insights_*` tables, `MetaInsightsAdapter`). The two epics both want Meta `/insights` data and would double-build the fetch+store layer if not bounded. **This plan does not fetch Meta directly** — it consumes #513's stored snapshots and owns only the Honcho-write leg. The boundary is specified in Decisions and the dedicated **#513 boundary** section.

## Who cares

- **The marketing pipeline / strategist profile** — the consumer of `peer-market-signal-*` claims; today it strategizes blind to real outcomes.
- **Brendan (operator)** — wants the next campaign to lean into what actually performed, not the model's guess.
- **Eng** — the current publish-stage Honcho write fires with low-signal Hermes output and a UTC-now date; it looks wired but carries no real metrics. This replaces guesswork with measured data behind the same gate.

## Decisions (locked — do not re-litigate)

1. **#513 owns Meta fetch + storage. This epic owns only the Honcho write.** This plan does NOT call `graph.facebook.com/.../insights`. It reads from #513's `insights_post_metrics_daily` (and the post→job linkage) and calls `recordPerformanceEvent`. Reason: a second Meta fetch path duplicates token resolution, rate-limit handling, scope dependence, and pool pressure that #513 already builds (issue #513 children D/E). One fetcher, two consumers (dashboard reads tables directly; Honcho reads tables → writes memory). See the **#513 boundary** section.
2. **Hard dependency on #513 child E (Meta adapter) landing.** Until `insights_post_metrics_daily` is populated for FB+IG, this epic has no data source. It does not ship before #513-E. This epic is sequenced *after* #513-E, *parallel-safe* with #513-F/G.
3. **Reuse the shipped write contract verbatim.** `scheduleHermesPublishPerformanceHonchoWrite` / `recordPerformanceEvent` / `scrubPlatformIdsFromPerformancePayload` / `topicPseudonymHexForPerformanceMemory` in `backend/memory/write-events.ts` are correct and stay. No new Honcho write function. The new code is a **worker that calls the existing function with real metrics**.
4. **Same gate, no new env var.** `HONCHO_WRITE_PUBLISH_ENABLED` already governs the write; `recordPerformanceEvent` self-gates and no-ops when off. The metrics snapshot (in #513's tables) is unaffected by the gate — only the Honcho leg is.
5. **The job document is `SocialContentJobRuntimeDocument`, read via `loadSocialContentJobRuntime(jobId)`** (`backend/marketing/runtime-state.ts:521`). The 2026-05-24 draft's `MarketingJobRuntimeDocument` / `readMarketingJobRuntimeDocument(jobId)` do not exist — do not use them.
6. **Idempotency is the existing key `sha256(jobId|publish|platform|YYYYMMDD)`** (`recordPerformanceEvent`, write-events.ts:679). Re-polling the same post on the same UTC day dedupes for free. We must pass the **post's real publish day**, not UTC-now, so the dedupe window is the publish day, and 24h/72h/7d/30d polls of the *same* metric-day collapse correctly. (The current callback passes UTC-now — see Current State note.)

## Current State (VERIFIED — master @ v0.1.13.15)

**Honcho write surface (shipped, correct):**
- `backend/memory/write-events.ts:708` — `scheduleHermesPublishPerformanceHonchoWrite({ doc, payloadRecord })`: `setImmediate`-wrapped, self-gates on `isHonchoEnabled() && isHonchoWritePublishEnabled()`, resolves tenant slug + `topicPseudonymHexForPerformanceMemory`, computes `ymd` as **UTC-now** (`new Date().toISOString().slice(0,10)...`, line 722), then calls `recordPerformanceEvent`.
- `backend/memory/write-events.ts:652` — `recordPerformanceEvent`: validates `publishedAtYmd` (`^\d{8}$`), validates `topicPseudonymHex`, scrubs via `scrubPlatformIdsFromPerformancePayload`, requires an https `source_url` (`extractPerformanceMetricsSourceUrl`), claims idempotency key (`idempotencyKey([jobId,'publish',platform,ymd])`, line 679), curates, persists queued finding to `peer-market-signal`.
- `backend/memory/write-events.ts:413` — `scrubPlatformIdsFromPerformancePayload`: strips `platform_post_id`/`post_id`/`fb_post_id`/`instagram_media_id`/`*_post_id`, redacts bare 10–20 digit numeric strings.
- `backend/memory/write-events.ts:447` — `extractPerformanceMetricsSourceUrl`: pulls first https `source_url|permalink|insights_url|metrics_url|canonical_url`, recurses into `.metrics`. **The payload MUST carry an https source url** or the write is skipped with a warning.
- `backend/memory/write-events.ts:388` — `topicPseudonymHexForPerformanceMemory(jobId, competitorUrl)`: stable 32-hex.

**Existing (low-signal) call sites — to be left in place and complemented, not removed:**
- `backend/marketing/hermes-callbacks.ts:1879` and `:1900` — fire `scheduleHermesPublishPerformanceHonchoWrite` on publish-stage completion with `multiStage.get('publish')?.primaryOutput ?? firstOutputRecord(payload)`. (The 2026-05-24 draft cited `:1558,1579` — stale.) These fire **at publish time**, before any real metrics exist; they typically no-op the write (no https `source_url` / no metrics) or write near-empty signal. This epic adds the *delayed, metric-bearing* write; the at-publish call stays as a harmless no-op until we decide to remove it (Out of Scope / P4).

**Publish records (the post→platform linkage we depend on):**
- `posts.platform_post_id TEXT` (`scripts/init-db.js:405`), `posts.published_at TIMESTAMPTZ` (`:408`), `posts.job_id`, `posts.platform`, `posts.published_status`. `meta-publishing.ts:592` INSERTs the post row with `platform_post_id`. **`scheduled_posts` has NO `published_at`, no platform-post-id, no `insights_fetched_at`** (verified `scripts/init-db.js:455-514`) — the 2026-05-24 draft's "query `scheduled_posts` for `published_at`/`insights_fetched_at`" is wrong; published-post state lives on `posts`.
- Token/account resolution for Meta: `resolveMetaPublishTarget` → `getDecryptedAccessTokenContextForTenantProvider(tenantId, provider)` (`meta-publishing.ts:166`) yields `{ accessToken, connectionId, externalAccountId }`. (Relevant only to #513-E, which does the fetching; listed for boundary clarity.)

**#513 scaffold is NOT on master.** Verified: `backend/insights/` does not exist; `grep -c insights_ scripts/init-db.js` = 0. The `insights_*` tables and `MetaInsightsAdapter` live on the unmerged `hammad/analytics-backend` branch (#513). **This epic cannot start until #513-A (schema) + #513-E (Meta adapter populating `insights_post_metrics_daily`) have merged.**

**Worker pattern to mirror:** `scripts/automations/scheduled-posts-worker.mjs` — `buildPool()` with `max: 3` (`:32`), `tickSafe(pool)` with `try/finally` resetting the `running` guard (`:430`), self-schedules via `setInterval(... INTERVAL_MS)` (`:462`). docker-compose runs it as a single-replica `restart: unless-stopped` sidecar pointed at in-network `http://aries-app:3000`.

## Architecture (target)

```
#513 (UPSTREAM — owns fetch+store; this epic does NOT duplicate):
  insights-sync-worker ─> MetaInsightsAdapter ─> graph.facebook.com/v21.0/.../insights
    ─> UPSERT insights_post_metrics_daily (tenant-scoped: reach, impressions,
       likes, comments, shares, saved, video_views, day)  + insights_posts
       (external_post_id, permalink, posted_at, links to posts/job)

THIS EPIC (owns the Honcho write leg only):
  honcho-performance-worker (NEW sidecar, ~30-min tick, try/finally guarded)
    │  per tenant, batched:
    ├─ SELECT due posts: posts.published_at between 24h..30d ago,
    │    published_status='published', job_id NOT NULL, AND a fresh-enough
    │    insights_post_metrics_daily row exists, AND not already honcho-written
    │    for (job_id, platform, metric_day)  [tracked in honcho_perf_writes]
    ├─ for each due post:
    │     doc = loadSocialContentJobRuntime(job_id)              (runtime-state.ts:521)
    │     metrics = latest insights_post_metrics_daily row for the post
    │     payloadRecord = {
    │        platform, published_at_ymd: <post publish day>,
    │        metrics: { reach, impressions, likes, comments, shares, saves,
    │                   video_views, source_url: <https insights permalink> },
    │        metrics_fetched_at, metrics_source_url: <https graph url> }
    │     payloadRecord = scrubPlatformIdsFromPerformancePayload(payloadRecord)  (belt+braces; fn also runs inside recordPerformanceEvent)
    │     recordPerformanceEvent({ tenantCtx, jobId, topicPseudonymHex,
    │        publishedAtYmd: <post day>, platform, payloadRecord })   (awaited; worker is not request-path)
    └─ mark honcho_perf_writes(job_id, platform, metric_day) on success
                          │
                          ▼ (existing, unchanged)
            curateFinding ─> peer-market-signal-<topicPseudonym>  (Honcho)
                          ▲
   gate: HONCHO_WRITE_PUBLISH_ENABLED (recordPerformanceEvent self-gates → no-op when off)
```

Two independent loops, one fetcher: #513's worker writes `insights_*`; this worker reads `insights_*` + writes Honcho. No shared mutable state beyond #513's read-only-to-us tables.

## #513 boundary (the anti-duplication contract — READ THIS)

| Concern | #513 (dashboard analytics) | This epic (Honcho perf) |
|---|---|---|
| Fetch Meta `/insights` | **OWNS** (`MetaInsightsAdapter`, #513-E) | NEVER calls Meta |
| Meta token/scope/re-consent | **OWNS** (#513-B/C) | depends on, doesn't manage |
| Store raw metrics | **OWNS** (`insights_post_metrics_daily`, `insights_posts`) | read-only consumer |
| Rate-limit / 429 backoff | **OWNS** (in adapter) | N/A (no Meta calls) |
| Operator dashboard UI | **OWNS** | none |
| Write metrics to Honcho memory | none | **OWNS** (`recordPerformanceEvent`) |
| Scrub platform IDs before memory | none | **OWNS** (`scrubPlatformIdsFromPerformancePayload`) |
| `peer-market-signal-*` peer | none | **OWNS** |
| Dedupe Honcho writes | none | **OWNS** (`honcho_perf_writes` + existing idempotency key) |

**Failure mode if the boundary is ignored:** if this epic adds its own Meta fetch (as the 2026-05-24 draft suggested), we get two token resolvers, two 429 backoff implementations, two `instagram_business_account` resolutions, and `ARIES_WEB_CONCURRENCY * DB_POOL_MAX` pool pressure doubles for the same data (CLAUDE.md guardrail #1). The contract: **#513-E's `insights_post_metrics_daily` is the single source; this worker is a pure reader-of-tables / writer-of-memory.**

**Interface this epic needs from #513-E (assert in a contract test, fixture-backed):** for a published post we can resolve `(tenant_id, job_id, platform, external_post_id, posted_at)` and read `{ reach, impressions, likes, comments, shares, saved, video_views, day, source_url-or-permalink }`. If #513-E's `insights_posts` does not carry `job_id`, this epic's join is `insights_posts.external_post_id = posts.platform_post_id AND insights_posts.tenant_id = posts.tenant_id`, then `posts.job_id` → `loadSocialContentJobRuntime`. Confirm the join key with #513-E before building Phase P1/P0's query.

## Child issues / phases

| # | Title | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| P0 | `honcho_perf_writes` ledger table + due-posts query (read model) | High | 2h / 25m | #513-A, #513-E merged |
| P1 | `recordPerformanceEvent` payload builder from insights rows (pure fn) | High | 3h / 35m | P0, #513-E table shape frozen |
| P2 | `honcho-performance-worker` sidecar (tick/finally, batched, tenant-scoped) | High | 4h / 45m | P1 |
| P3 | docker-compose sidecar + ops gate verification | Medium | 1.5h / 20m | P2 |
| P4 | Remove/quiet the at-publish low-signal write (optional cleanup) | Low | 1h / 15m | P2 shipped + observed |

```
#513-A ─┐
#513-E ─┴─> P0 ──> P1 ──> P2 ──> P3
                                  └─> P4 (optional, after observation)
```

**Sequencing rationale:** P0/P1 are pure data-shape work testable with fixtures the moment #513-E's table columns are frozen — no live Meta. P2 wires the loop. P3 deploys. P4 is deferred cleanup so we can observe both writes side-by-side first.

---

## P0 — Ledger table + due-posts query

**Implementation:**
1. Add to `scripts/init-db.js` (additive, idempotent, follow the house pattern):
   ```sql
   CREATE TABLE IF NOT EXISTS honcho_perf_writes (
     tenant_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
     job_id     TEXT    NOT NULL,
     platform   TEXT    NOT NULL,
     metric_day DATE    NOT NULL,
     written_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, job_id, platform, metric_day)
   );
   ```
   This is a *worker-side* ledger distinct from the Honcho-side `honcho_write_idempotency_keys` (write-events.ts) — it lets the due-posts query cheaply skip already-written posts without re-driving `recordPerformanceEvent`'s idempotency claim every tick. `tenant_id INTEGER` matches `organizations.id int4` (do not repeat #513's BIGINT convention violation).
2. New `backend/memory/perf-insights-read.ts`: `selectDuePerformancePosts(tenantId, client)` → joins `posts` (published_at in 24h..30d, `published_status='published'`, `job_id NOT NULL`) to #513's `insights_post_metrics_daily` (latest row per post), LEFT JOIN `honcho_perf_writes` to exclude already-written `(job_id, platform, metric_day)`. Tenant-scoped, parameterized, `LIMIT` capped (e.g. 200/tick). **No `pool.connect()` held across anything** — single `pool.query`.

**Acceptance:** table created idempotently with INTEGER tenant FK + CASCADE; query returns due rows for one tenant only (cross-tenant isolation asserted); already-written `(job_id,platform,metric_day)` excluded; `LIMIT` capped.

## P1 — Payload builder (pure function)

**Implementation:** `backend/memory/perf-insights-payload.ts`:
- `buildPerformancePayloadRecord({ platform, publishDayYmd, metricsRow, sourceUrl, fetchedAt })` → returns the `payloadRecord` shape `recordPerformanceEvent` consumes: `{ platform, published_at_ymd, metrics: { reach, impressions, likes, comments, shares, saves, video_views, source_url }, metrics_fetched_at, metrics_source_url }`.
- `sourceUrl` MUST be https (the post permalink or the graph insights URL); if missing/non-https, return `null` and the worker skips (mirrors `recordPerformanceEvent`'s own guard — fail-soft, logged).
- Map #513 column names → payload metric keys explicitly (e.g. `saved` → `saves`). Run `scrubPlatformIdsFromPerformancePayload` here as belt-and-braces (idempotent with the scrub inside `recordPerformanceEvent`).

**Acceptance:** pure unit test — given a fixture `insights_post_metrics_daily` row + permalink, emits a payload with no raw `platform_post_id`/`ig_media_id`/numeric-id strings, a valid https `source_url`, and `published_at_ymd` = the **post's** publish day (not UTC-now). Missing https source → returns null.

## P2 — `honcho-performance-worker` sidecar

**Implementation:** new `scripts/automations/honcho-performance-worker.mjs` (mirror `scheduled-posts-worker.mjs`):
- `buildPool()` with `max: 3`; dedicated small pool, NOT the app pool (guardrail #1 — keep worker DB pressure off the request path).
- `tickSafe(pool)` with `try { ... } finally { running = false }`; `setInterval(() => void tickSafe(pool), INTERVAL_MS)` at 30 min. Mirror the `running` re-entrancy guard so a slow tick never overlaps.
- Each tick, per connected tenant: `selectDuePerformancePosts` → for each, `loadSocialContentJobRuntime(job_id)`; if doc missing, skip + log (don't throw). Build payload (P1); if null, mark nothing and continue. `topicPseudonymHex = topicPseudonymHexForPerformanceMemory(job_id, doc.inputs?.competitor_url ?? null)`. Build `tenantCtx` (same shape as write-events.ts:729). `await recordPerformanceEvent({ tenantCtx, jobId, topicPseudonymHex, publishedAtYmd, platform, payloadRecord })`.
- On success, UPSERT `honcho_perf_writes(tenant_id, job_id, platform, metric_day)` `ON CONFLICT DO NOTHING`.
- **Per-post try/catch** so one bad post doesn't abort the tenant batch (resumability — partial progress preserved; CLAUDE.md). **Per-tenant try/catch** so one tenant doesn't abort the tick.
- `recordPerformanceEvent` self-gates on `HONCHO_WRITE_PUBLISH_ENABLED`; when off, it no-ops and we do NOT write the ledger (so flipping the gate on later re-drives the writes). Verify: do not mark `honcho_perf_writes` unless `isHonchoWritePublishEnabled()` is true — read the gate in the worker to decide whether to ledger.

**Acceptance:** with a seeded published post (publish_at 36h ago) + a seeded `insights_post_metrics_daily` row, one tick calls `recordPerformanceEvent` once with the scrubbed payload and writes one `honcho_perf_writes` row; a second tick 10 min later is a no-op (ledger hit); a thrown error on one post leaves the other posts' writes intact and `running` reset to false; with gate OFF, no Honcho write and no ledger row.

## P3 — docker-compose sidecar + ops

**Implementation:** add `aries-honcho-performance-worker` to `docker-compose.yml`, mirroring `aries-scheduled-posts-worker`: single replica, `restart: unless-stopped`, in-network `APP_BASE_URL=http://aries-app:3000`, `APP_INSTANCE_ID=honcho-performance-worker`, same DB env, `command` runs the new script. Inherits `HONCHO_WRITE_PUBLISH_ENABLED` (ON in prod). Does NOT need Meta env (no Meta calls).

**Acceptance:** sidecar boots, logs a tick, no Meta env required; stopping the service halts Honcho perf writes without touching the app or #513's sync worker.

## P4 — Quiet the at-publish low-signal write (optional, deferred)

After P2 has run in prod and we've confirmed the delayed worker writes real-metric findings, remove or guard the two at-publish `scheduleHermesPublishPerformanceHonchoWrite` calls (`hermes-callbacks.ts:1879,1900`) so Honcho isn't fed the empty at-publish payload. Defer until observation confirms the worker covers the same `(job, platform, day)` keys.

**Acceptance:** publish callback no longer fires the perf write (or fires it only when the payload already carries metrics); no change to the worker's writes; idempotency keys unaffected.

---

## Testing Plan (fixture-primary)

| Layer | What | Fixture / live | Count |
|-------|------|----------------|-------|
| Unit | `buildPerformancePayloadRecord`: column→metric mapping, https-source guard, publish-day (not UTC-now), no raw IDs leak | fixture `insights_post_metrics_daily` row | +5 |
| Unit | `selectDuePerformancePosts` SQL shape: 24h..30d window, status filter, ledger-exclude, LIMIT cap | in-memory/SQL string assert | +3 |
| Integration | one tick → `recordPerformanceEvent` called once with scrubbed payload; ledger row written; gate-OFF → no write, no ledger | mock `recordPerformanceEvent` + seeded posts | +4 |
| Integration | re-tick dedupe (ledger hit); per-post throw isolation; per-tenant isolation (no cross-tenant due rows) | seeded multi-tenant | +3 |
| Live-DB | with a real published post + seeded insights row in the live DB, worker writes a `peer-market-signal` queued finding and a `honcho_perf_writes` row; no raw `platform_post_id`/`ig_media_id` in the Honcho payload | live DB (precedent: `tests/marketing/ingest-production-assets-live-db.test.ts`) | +2 |
| Contract | #513 interface: assert the `(tenant_id, job_id, platform, external_post_id, posted_at)` + metric columns are resolvable from a fixture mirroring #513-E's `insights_posts`/`insights_post_metrics_daily` | fixture | +1 |

Run via `tsx --test` with `APP_BASE_URL=https://aries.example.com`; gate the suite under `npm run verify` additions. No test calls Meta.

## Rollback

- **Kill switch:** `HONCHO_WRITE_PUBLISH_ENABLED=false` — `recordPerformanceEvent` no-ops; the worker stops writing memory and stops ledgering (#513's `insights_*` tables keep filling, dashboard unaffected). No data migration.
- **Stop the sidecar:** `docker compose stop aries-honcho-performance-worker` — halts the Honcho leg entirely; app + #513 sync worker untouched.
- **Schema:** `honcho_perf_writes` is additive/idempotent; dropping it only forces re-evaluation of dedupe via the existing Honcho-side idempotency key (no data loss, possible duplicate-write attempts that the Honcho key still catches).

## Out of Scope

- **Fetching Meta `/insights` directly** — owned by #513-E. This epic is a pure consumer.
- **The analytics dashboard UI** — #513-G.
- **Stories perf into Honcho** — #513-F builds story ingestion; feeding story metrics to Honcho is a fast-follow once #513-F lands (same pattern, `insights_story_snapshots` source).
- **Removing the at-publish write** — tracked as deferred P4, not blocking.
- **Backfilling Honcho for posts published before this worker** — one-off script if desired later.
- **Non-Meta platforms (TikTok/YouTube)** — gated on #513 adding those adapters first.
- **Aggregating `peer-market-signal-*` into strategy hints for the next run** — the marketing pipeline's job once signal accumulates.

## Files Reference

| File | Change | Phase |
|------|--------|-------|
| `scripts/init-db.js` | add `honcho_perf_writes` table (INTEGER tenant FK + CASCADE) | P0 |
| `backend/memory/perf-insights-read.ts` (NEW) | `selectDuePerformancePosts` — joins `posts` + #513 `insights_post_metrics_daily`, ledger-excludes | P0 |
| `backend/memory/perf-insights-payload.ts` (NEW) | `buildPerformancePayloadRecord` — insights row → `recordPerformanceEvent` payload | P1 |
| `scripts/automations/honcho-performance-worker.mjs` (NEW) | tick/finally sidecar, batched, tenant-scoped, calls `recordPerformanceEvent` | P2 |
| `docker-compose.yml` | `aries-honcho-performance-worker` sidecar (mirror scheduled-posts-worker) | P3 |
| `backend/memory/write-events.ts` | UNCHANGED — reused as-is (`recordPerformanceEvent:652`, `scrub:413`, `topicPseudonym:388`) | — |
| `backend/marketing/runtime-state.ts` | UNCHANGED — `loadSocialContentJobRuntime:521` reused | — |
| `backend/marketing/hermes-callbacks.ts:1879,1900` | optionally quiet the at-publish write | P4 |

## Related

- Issue #513 — Meta insights dashboard epic; **hard upstream dependency** (children A + E). Boundary defined above.
- `docs/plans/2026-05-24-honcho-performance-insights-integration.md` — prior draft; corrected here (stale `:1558,1579` call sites → `:1879,1900`; `MarketingJobRuntimeDocument` → `SocialContentJobRuntimeDocument`; `scheduled_posts.published_at`/`insights_fetched_at` do not exist — published state is on `posts`; "build your own Meta fetcher" → reuse #513-E).
- `docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md` — the Phase 2 spec that shipped the write functions.
