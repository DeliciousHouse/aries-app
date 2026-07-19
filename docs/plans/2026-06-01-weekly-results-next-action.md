# Weekly Results MVP — as-built insights implementation plan

> **For Hermes:** Use test-driven-development when implementing this plan task by task.
>
> **Status:** Rebased plan (2026-07-19), not implemented. AA-100 / analytics-roadmap S3-4. Verified against `origin/master` at `d6fa6a97f0ce230e5ceb8ea93081e73d9fea47a8` (PR #847). The implementation ticket remains S5-1 in `docs/plans/2026-07-07-analytics-page-roadmap.md`.
>
> **Plan-only boundary:** This document changes no runtime behavior, production state, credentials, feature flags, or deployment. It replaces the stale 2026-06-01 assumption that post insights are absent.

**Goal:** Add a default-OFF weekly-results panel to `/dashboard/results` that summarizes one completed week from the shipped insights data, identifies the best and weakest eligible posts by one disclosed metric, and recommends one evidence-linked experiment for the next week.

**Architecture:** Build a tenant-scoped read model inside `backend/insights/**`, backed by `insights_posts`, the latest cumulative row in `insights_post_metrics_daily`, and the existing freshness/attribution seams. Serve it from one authenticated `/api/insights/weekly-results` route and render it above the existing Results roster. The report performs no platform fetches, writes no memory, and publishes nothing.

**Tech stack:** Next.js 16 App Router, TypeScript, React 19, PostgreSQL, the existing Aries v1 API client/hook conventions, and Node's test runner through `tsx`.

---

## 1. Rebase verdict

The old plan is no longer executable as written:

1. **Insights are built, not absent.** `scripts/init-db.js` creates `insights_posts` and `insights_post_metrics_daily`; `backend/insights/sync/dispatcher.ts` writes post rows and cumulative daily metric snapshots; `backend/insights/latest-post-metrics-sql.ts` defines the shared newest-snapshot read. A report can now rank real posts without inventing engagement.
2. **The cumulative-metric correctness fix has landed.** S2-1 changed readers from SUM-across-snapshots to the newest snapshot, S2-2 made same-day metric writes refresh in place, and S2-5 pins ranking arithmetic (`tests/insights-latest-snapshot-metrics.requires-infra.test.ts`, `tests/insights-post-metrics-upsert.requires-infra.test.ts`, `tests/insights-math-pinning.test.ts`). The report must reuse those semantics.
3. **Attribution is still the load-bearing dependency.** `insights_posts.aries_post_id` exists in `scripts/init-db.js`, but there is no production writer under `app/**` or `backend/**` at this baseline. The current Activity and Top builders intentionally count all connected-channel posts. S3-3, S3-7, and S4-1 must land before the report can call a result an Aries result.
4. **`ARIES_INSIGHTS_513_TABLES_PRESENT` is not a table-availability flag for this report.** It still gates the separate Honcho performance worker in `backend/memory/insights-513-contract.ts` and defaults empty on `aries-honcho-performance-worker` in `docker-compose.yml`. Weekly Results reads the landed insights tables directly and must not consult that legacy gate.
5. **Memory promotion is a different roadmap item.** Approve/Edit/Reject for queued Honcho findings is F8/S6-5. It is not part of S5-1 and is removed from this MVP.
6. **The Results surface is still thin.** `app/dashboard/results/page.tsx` renders only `AriesResultsScreen`; `frontend/aries-v1/results-screen.tsx` fetches runtime posts, filters `status === 'live'`, and renders links. `frontend/aries-v1/view-models/results.ts` exists, but there is no wired results presenter. The weekly report is additive; it does not replace or revive dead presentation code.

## 2. Verified current state

### Results UI

- `app/dashboard/results/page.tsx` wraps `AriesResultsScreen` in `AppShellLayout`.
- `frontend/aries-v1/results-screen.tsx` has no week boundary, insights read, best/weakest comparison, or next action.
- `tests/runtime-pages.test.ts` pins the current page composition and `/results` redirect.
- `hooks/use-runtime-social-content.ts` remains the legacy roster's data source. Weekly Results must load independently so roster hydration or failure does not block the report.

### Insights schema and writers

- `scripts/init-db.js` defines:
  - `insights_posts(tenant_id, account_id, platform, external_post_id, published_at, media_type, title, caption, permalink, content_type, aries_post_id, ...)`.
  - `insights_post_metrics_daily(tenant_id, post_id, platform, date, views, reach, likes, comments_count, shares, saves, ...)` with primary key `(tenant_id, post_id, date)`.
- `backend/insights/sync/dispatcher.ts`:
  - upserts platform posts;
  - now stamps `content_type` via `classifyPostContentType` (S3-2);
  - refreshes same-day metric snapshots with `ON CONFLICT ... DO UPDATE` (S2-2);
  - does **not** stamp `aries_post_id` on master;
  - does not yet lift `reach` or `saves` into its post-metric INSERT, so those columns can remain NULL even when an adapter fetched them. S4-2 owns that writer gap.
- Per-post snapshots are lifetime-cumulative, not daily deltas. `LATEST_POST_METRICS_LATERAL` in `backend/insights/latest-post-metrics-sql.ts` is the canonical read contract.

### Existing readers that should be reused, not copied blindly

- `buildTopSnapshot` and `deriveTopPostMetrics` in `backend/insights/top/top-snapshot-builder.ts` prove real ranking is possible from the latest post snapshot.
- `buildNarrativeSnapshot` in `backend/insights/narrative/snapshot-builder.ts` already selects a top post with `LATEST_POST_METRICS_LATERAL`.
- `handleGetInsightsPosts` in `backend/insights/read-api.ts` returns latest lifetime views/likes/comments/shares to `/dashboard/analytics`.
- `buildActivitySnapshot` in `backend/insights/activity/activity-snapshot-builder.ts` counts published posts and high performers from the same tables.
- `handleGetInsightsFreshness` and `computeFreshness` under `backend/insights/freshness/**` expose `fresh`, `partial`, `stale`, and `never_synced`; a failed latest account run is deliberately collapsed to overall `stale` while its per-account `latestStatus` remains available.
- `resolveTenantInsightsTimeZone` and `tenantZonePeriodStart` are the existing tenant-timezone seams.

The report must **not** call the existing Top handler and treat its payload as a complete ranking: it returns at most five posts, has no weakest-post contract, and its source query first limits candidates. Weekly Results needs one bounded report query over the complete selected-week cohort, while reusing the same latest-snapshot semantics and pure metric helpers.

### Flags and production truth at the rebased baseline

- `ARIES_WEEKLY_RESULTS_ENABLED` does not exist yet in code, `.env.example`, `docker-compose.yml`, or `CLAUDE.md`.
- The insights-sync worker itself runs, but repository defaults keep Composio analytics dormant: `COMPOSIO_ENABLED=false`; `ANALYTICS_PROVIDER` defaults to `composio`, so the master switch is the effective default blocker.
- The analytics roadmap records Facebook as live-verified and Instagram as code-complete but live-unverified. S3-5 owns Instagram live verification. This plan must not upgrade that statement without new evidence.
- `ARIES_COMMENT_CLASSIFICATION_ENABLED` now defaults ON on `aries-insights-sync-worker` (PR #847). Sentiment remains contextual only; it is not a Weekly Results ranking input.
- `ARIES_INSIGHTS_513_TABLES_PRESENT` remains default empty for the separate Honcho worker. It neither proves nor disproves that the report tables exist.

---

## 3. Agreed MVP slice (S5-1)

### In scope

1. The most recent **completed Monday–Sunday week in the tenant's business timezone**, shown with explicit start/end dates and timezone.
2. A compact summary of eligible posts from the selected attribution scope.
3. One disclosed, report-wide ranking basis and a real best/weakest post pair from `insights_post_metrics_daily`.
4. A current-versus-prior direction using the same metric contract, with `null` rather than an absurd percentage when the prior value is zero (reuse `trendsPctDelta`).
5. One deterministic next-week experiment linked to the measured winner; no LLM and no causal overclaim.
6. Freshness, attribution scope, metric coverage, and excluded-post disclosures.
7. A default-OFF panel above the current `/dashboard/results` screen.

### Explicitly deferred

- Approve/Edit/Reject memory promotion (F8/S6-5), queued research findings, and Honcho writes.
- Published/skipped/blocked reliability accounting from `posts` and `scheduled_posts`.
- PDF/print, CSV, email digest, share links, multi-week explorer, or arbitrary week picker.
- New Meta/Composio calls, OAuth scopes, adapters, backfills, or production flag changes.
- An LLM-generated narrative or autonomous recommendation.
- Cross-workspace/agency rollups.
- Replacing `AriesResultsScreen`, wiring the unused results view model, or consolidating `/insights` with `/dashboard/analytics`.

This cut intentionally makes S5-1 a read-only insights product. Operational reliability summaries and memory promotion can be valuable later, but combining them would recreate the old XL plan and hide the report behind unrelated mutation work.

---

## 4. Locked product and data decisions

### 4.1 Week and snapshot semantics

- Default to the last completed ISO week (Monday 00:00 inclusive to the next Monday 00:00 exclusive) in the tenant timezone returned by `resolveTenantInsightsTimeZone`.
- The UI does not expose a week selector in v1. The builder accepts an injected `now` for deterministic tests.
- A post belongs to the report by `insights_posts.published_at` within that tenant-local interval.
- Per-post values are **latest lifetime totals as of the report build**, not engagement earned only inside that week. The response and UI call this out as “performance to date for posts published during this week.” Never label a cumulative snapshot as a daily or in-week delta.
- The route returns freshness `dataAsOf` with the existing least-fresh-account semantics and a metric snapshot date on each ranked post. `stale`, `partial`, and `never_synced` states remain visible.

This preserves the landed cumulative-snapshot contract and avoids pretending the current schema stores exact per-day post deltas.

### 4.2 Attribution scope

- Hard implementation dependency: S3-3 production stamp/backfill plus S3-7/S4-1's shared coverage decision must be merged first.
- Weekly Results consumes the attribution-scope helper produced by S4-1; it does not invent a second threshold.
- Preferred scope is `aries_attributed`, filtering `insights_posts.aries_post_id IS NOT NULL`.
- If the shared helper selects an all-channel fallback, the report may render only with an explicit `scope='all_channel_fallback'` badge and copy such as “Connected-channel results; attribution is still calibrating.” It must not say “Aries drove” or “Aries posts.”
- The response includes attributed, total, and excluded counts so the UI cannot hide partial attribution.

### 4.3 Ranking contract

- V1 ranking basis is **views**. Facebook and Instagram both declare `post_view_count` in `backend/insights/platforms/capabilities.ts`, and `dispatcher.ts` writes `views` today. This avoids relabeling fallback views as reach while S4-2's reach writer is still pending.
- “Best” means highest latest cumulative views; “weakest” means lowest latest cumulative views among the same eligible cohort. UI labels must read “Best by views” and “Weakest by views.”
- A row is ranking-eligible only when it has a latest metric snapshot and `views IS NOT NULL`. Zero views with a real snapshot is valid; no snapshot is missing data, not zero.
- Require at least two eligible posts. With zero or one, return `ranking.available=false` and a specific reason (`no_metric_snapshots` or `insufficient_comparison_set`) instead of choosing a fake loser.
- Deterministic ties: views, then interaction count (`likes + comments_count + shares + saves`), then `published_at`, then numeric `id`. Best sorts descending; weakest sorts ascending. The same post cannot occupy both positions.
- Show likes/comments/shares/saves only as supporting counts and preserve unavailable-vs-zero metadata. Do not turn missing saves into a performance penalty.
- S4-2 can add a separately reviewed reach-based mode later. It is not allowed to silently change the v1 ranking basis.

### 4.4 Trend and next action

- Compare the selected cohort's aggregate latest views with the immediately prior completed week's cohort, using the same attribution and eligibility rules. Label the comparison “post cohorts, performance to date,” not “views earned this week.”
- Use `trendsPctDelta` for the percentage and return `delta=null` when the prior cohort is zero or the magnitude is not meaningful.
- Next action is deterministic:
  1. stale/never-synced freshness (including a failed latest account run) → refresh/fix analytics before interpreting results;
  2. attribution fallback → finish attribution before claiming Aries impact;
  3. fewer than two eligible posts → keep collecting data;
  4. otherwise → “Test one more `<best.contentType || mediaType>` post next week, changing one variable,” with the winning post id and view count as evidence.
- The copy says “test”/“experiment,” never “this caused the result.”

---

## 5. Target contract and data flow

```text
insights_accounts + insights_sync_runs
  -> freshness / dataAsOf

insights_posts
  -> completed-week cohort
  -> S4-1 attribution scope
  -> content_type / media_type / permalink

insights_post_metrics_daily
  -> newest cumulative snapshot per post
  -> views-based coverage + ranking
  -> prior-week cohort comparison

backend/insights/weekly-results/weekly-results-builder.ts
  -> GET /api/insights/weekly-results
  -> hooks/use-weekly-results.ts
  -> frontend/aries-v1/weekly-results-panel.tsx
  -> /dashboard/results above AriesResultsScreen
```

Proposed response shape:

```ts
export interface WeeklyResultsReport {
  week: {
    start: string;
    endExclusive: string;
    label: string;
    timeZone: string;
  };
  freshness: {
    status: 'fresh' | 'partial' | 'stale' | 'never_synced';
    dataAsOf: string | null;
    staleThresholdMinutes: number;
    accounts: Array<{
      platform: string;
      displayName: string | null;
      lastSuccessAt: string | null;
      latestStatus: string | null;
    }>;
  };
  scope: {
    kind: 'aries_attributed' | 'all_channel_fallback';
    coveragePct: number;
    attributedPosts: number;
    totalPosts: number;
  };
  summary: {
    publishedPosts: number;
    eligiblePosts: number;
    excludedNoSnapshot: number;
    totalViews: number;
    priorWeekTotalViews: number;
    viewsDeltaPct: number | null;
  };
  ranking:
    | {
        available: true;
        basis: 'views';
        best: WeeklyResultPost;
        weakest: WeeklyResultPost;
      }
    | {
        available: false;
        basis: 'views';
        reason: 'no_metric_snapshots' | 'insufficient_comparison_set';
      };
  nextAction: {
    kind: 'fix_sync' | 'finish_attribution' | 'collect_data' | 'run_experiment';
    headline: string;
    rationale: string;
    evidencePostIds: number[];
  };
}
```

`WeeklyResultPost` includes only customer-safe fields: internal insight id, Aries post id when present, platform, a plain-text title/caption fallback truncated to 160 characters, permalink, published timestamp, content/media type, views, supporting available metrics, and metric snapshot date. No `raw_source`, platform tokens, connection ids, or unbounded captions leave the route.

---

## 6. Implementation tasks (TDD order)

### Task 0 — Enforce prerequisite gates

**Objective:** Do not start S5-1 until the metric and attribution contracts are actually usable.

**Verify on implementation branch:**

1. `LATEST_POST_METRICS_LATERAL` is still used by all post-metric readers and `tests/insights-latest-snapshot-metrics.requires-infra.test.ts` still proves newest-not-SUM behavior.
2. Both same-day upsert tests still pass.
3. S2-3's tenant-timezone helpers and builder wiring still pass their pure/requires-infra tests; the report does not reuse the separately deferred UTC-bucketed Trends builder.
4. S3-3 stamps and backfills `insights_posts.aries_post_id` in production paths.
5. S4-1 exports one attribution-scope decision used by Activity/Top and exposes its coverage/fallback result for Weekly Results.
6. S3-5 has either live-verified Instagram or the report's rollout note still says Facebook verified / Instagram unverified.

**Stop condition:** If attribution is not landed, keep `ARIES_WEEKLY_RESULTS_ENABLED` absent/OFF and do not substitute all-channel data under Aries copy.

### Task 1 — Add pure week, ranking, and recommendation contracts

**Files:**

- Create: `backend/insights/weekly-results/types.ts`
- Create: `backend/insights/weekly-results/weekly-results-logic.ts`
- Test: `tests/weekly-results-logic.test.ts`

**RED:** Add fixtures for DST-safe completed-week boundaries, two-post best/weakest ranking, deterministic ties, zero-vs-missing views, insufficient samples, prior-zero delta, and all four next-action priorities.

**GREEN:** Implement pure helpers only. Use the existing timezone utilities and `trendsPctDelta`; do not duplicate percentage math.

**Expected command:**

```bash
APP_BASE_URL=https://aries.example.com npx tsx --test tests/weekly-results-logic.test.ts
```

### Task 2 — Build one tenant-scoped weekly read model

**Files:**

- Create: `backend/insights/weekly-results/weekly-results-builder.ts`
- Modify only if needed for reuse: `backend/insights/freshness/handler.ts` (extract/export a tenant-scoped freshness reader without changing the endpoint response)
- Modify only if needed for reuse: `backend/insights/latest-post-metrics-sql.ts` (expose snapshot date; keep all existing callers behavior-identical)
- Test: `tests/weekly-results-builder.test.ts`
- Requires-infra test: `tests/weekly-results-builder.requires-infra.test.ts`

**RED fixtures:** tenant A/B rows, current/prior cohorts, attributed/unattributed rows, NULL snapshot, zero-view snapshot, ties, stale/partial sync, and a hostile caption/raw payload.

**GREEN implementation constraints:**

- Export `buildWeeklyResultsReport(tenantId, { now }, deps?)` with an injected pool/clock seam.
- Parameterize every query and include `tenant_id = $1` on every table leg.
- Run DB work sequentially on one acquired client; no `Promise.all` pool fan-out.
- Bound both cohorts to the two completed weeks; never scan arbitrary history.
- Select one newest cumulative snapshot per post, never SUM snapshots for one post.
- Reuse S4-1 attribution scope and pure ranking logic.
- Return typed, customer-safe objects only.
- Perform no writes and no network calls.

**Expected commands:**

```bash
APP_BASE_URL=https://aries.example.com npx tsx --test tests/weekly-results-builder.test.ts
ARIES_TEST_REQUIRES_INFRA_ENABLED=1 APP_BASE_URL=https://aries.example.com npx tsx --test tests/weekly-results-builder.requires-infra.test.ts
```

The requires-infra test self-skips without DB configuration, matching current repository convention; the fake-pool behavioral test must run in `npm run verify`.

### Task 3 — Add the flag-gated authenticated route and typed client

**Files:**

- Create: `backend/insights/weekly-results/env.ts`
- Create: `app/api/insights/weekly-results/route.ts`
- Modify: `lib/api/aries-v1.ts`
- Test: `tests/weekly-results-route.test.ts`
- Test: `tests/frontend-api-layer.test.ts`

**Behavior:**

- `isWeeklyResultsEnabled` accepts the repository-standard `1|true|yes|on`; default OFF.
- Flag OFF returns a real 404 before tenant/database work.
- Flag ON resolves tenant through `loadTenantContextOrResponse`, calls the builder with the session tenant only, and returns `Cache-Control: no-store` so freshness and flag rollback are immediate.
- No client-supplied tenant id or arbitrary SQL date reaches the builder.
- Unexpected builder errors emit one bounded structured `console.error('[weekly-results]', { event: 'build-failed', tenantId, errorName })` and return `500 { error: 'weekly_results_unavailable' }`; error messages, SQL, captions, provider payloads, and connection details never enter the log or response.
- Add `getWeeklyResults()` and exact response types to the existing Aries v1 client.

**Route tests:** OFF/no DB call, unauthenticated, enabled success, builder failure safe response, and tenant id derived from session rather than query/body.

### Task 4 — Render the additive Results panel

**Files:**

- Create: `hooks/use-weekly-results.ts`
- Create: `frontend/aries-v1/weekly-results-panel.tsx`
- Modify: `app/dashboard/results/page.tsx`
- Modify: `tests/runtime-pages.test.ts`
- Test: `tests/weekly-results-panel.test.ts`

**Behavior:**

- Keep `AriesResultsScreen` mounted below the new panel; do not change its roster fetch or copy in this ticket.
- Server-side flag OFF preserves the current page composition pinned by `tests/runtime-pages.test.ts` and causes no weekly-results request.
- Flag ON renders a separate loading/error/success panel immediately, independent of runtime-post hydration.
- Surface: week/date range, freshness, scope badge, posts/eligible/excluded counts, total views + cohort delta, Best by views, Weakest by views, and one next action.
- Missing data is explicit. Never render a zero for a missing snapshot, hide stale sync, or imply causality.
- Permalinks open safely; raw captions are plain React text, never HTML.

**Component tests:** Use `React.createElement` in the `.test.ts` file so it is included by the repository's existing `tests/*.test.ts tests/**/*.test.ts` script. Cover flag OFF unchanged; loading/error/retry; stale/partial warning; attribution fallback copy; two-post ranking; insufficient data; no leaked `raw_source`; next-action evidence.

### Task 5 — Wire validation and rollout docs

**Files:**

- Modify: `.env.example`
- Modify: `docker-compose.yml` (`aries-app` service only, `${ARIES_WEEKLY_RESULTS_ENABLED:-0}`)
- Modify: `CLAUDE.md` environment-variable section
- Modify: `scripts/verify-regression-suite.mjs`
- Modify: `VERSION` and `CHANGELOG.md` only through the normal ship workflow

**Documentation contract:**

`ARIES_WEEKLY_RESULTS_ENABLED=1` enables the read-only weekly-results panel and GET route. Default OFF. It does not enable the insights sync, does not bypass attribution/freshness checks, does not consult `ARIES_INSIGHTS_513_TABLES_PRESENT`, and does not write memory or publish content.

**Required gates:**

```bash
npm run workspace:verify
npm run validate:repo-boundary
npm run validate:banned-patterns
npm run verify
npm run test
npm run lint
npm run typecheck
npm run build
```

Use CI's Ubuntu run as the authoritative Linux verification.

---

## 7. Rollout, human-floor live verification, and rollback

### Rollout

1. Merge and deploy with `ARIES_WEEKLY_RESULTS_ENABLED=0`. Confirm `/dashboard/results` is unchanged and `/api/insights/weekly-results` is 404.
2. Confirm the prerequisite PRs are deployed: latest-snapshot math, intraday upserts, attribution writer/backfill, and shared attribution scope.
3. Confirm sync state without exposing credentials: latest Facebook run is current and non-failed; Instagram remains labeled unverified until S3-5 produces evidence.
4. Enable the flag first in an isolated canary environment/instance that serves only the intended tenant. Do not turn this global flag ON on a shared multi-tenant production deployment; add tenant-level targeting in a separately reviewed prerequisite if isolated rollout is unavailable.

### Human-floor live verification

The operator performs these checks in the real browser and source platform; no agent uses or prints credentials:

1. Open `/dashboard/results` and capture the rendered panel, date range, timezone, freshness, attribution badge, and excluded count.
2. Choose two posts in the completed-week cohort. Compare their displayed views and order with the newest rows visible through `/dashboard/analytics` and the connected platform's native analytics. Any unexplained mismatch blocks rollout.
3. Confirm the best and weakest cards are distinct, both have real metric snapshots, and missing-metric posts are disclosed rather than ranked as zero.
4. Confirm an attributed report links to the expected Aries post; if the scope falls back, verify the UI says connected-channel results and makes no Aries-impact claim.
5. Confirm the recommendation cites the measured winning post and is framed as an experiment, not a causal fact.
6. Verify legacy live-result cards still load below the panel and their slow/error state does not hide the report.
7. If OAuth reauthorization, new permissions, spend, or secret access is required, stop and route that item to Brendan under the team charter; do not work around it.

**Live acceptance:** selected post values agree with the native source within the platform's documented refresh lag and the existing analytics trust bar (target ±5% when the source exposes comparable numbers); attribution and freshness labels are true; no cross-tenant data appears.

### Rollback

- Set `ARIES_WEEKLY_RESULTS_ENABLED=0` and restart/redeploy the app service. The panel disappears and the route returns 404 without waiting for cache expiry.
- The feature is read-only and adds no schema, so rollback needs no data migration or cleanup.
- Do not disable the insights sync or `ARIES_COMMENT_CLASSIFICATION_ENABLED` to roll back this panel; those are independent systems.
- Trigger rollback immediately for tenant leakage, unexplained metric mismatch, stale data presented as current, missing attribution disclosure, or a page-load regression that blocks the existing Results roster.

---

## 8. Acceptance checklist

- [ ] Plan prerequisites S2-1/S2-2/S2-3/S2-5 and S3-3/S3-7/S4-1 are verified on the implementation baseline.
- [ ] No code path treats `ARIES_INSIGHTS_513_TABLES_PRESENT` as report availability.
- [ ] Report reads the complete bounded cohort and newest cumulative metric row per post.
- [ ] Best and weakest are real, distinct, views-ranked posts with deterministic ties and explicit missing-data handling.
- [ ] Attribution scope and sync freshness are visible and tested.
- [ ] One evidence-linked, non-causal next action renders.
- [ ] Flag OFF leaves `/dashboard/results` unchanged and the route invisible.
- [ ] No memory write, publish, external fetch, credential use, schema change, or production action was added to S5-1.
- [ ] Pure/fake-pool tests execute in `npm run verify`; full local gates pass; CI is green.
- [ ] Human operator completes the live checklist before leaving the flag ON.

## 9. Related roadmap ownership

- S3-3 / S3-7 / S4-1: attribution writer, coverage helper, and attribution views — hard prerequisites, not reimplemented here.
- S4-2: reach/saves/profile-visits writer — future ranking enrichment; views remain the locked v1 basis.
- S3-5: Instagram live verification — controls rollout truth, not code availability.
- S5-1: this Weekly Results MVP.
- F8 / S6-5: queued-performance-finding Approve/Edit/Reject — separate follow-up.
- F2 / S5-3 / S8-3: CSV and print reporting — separate follow-ups.