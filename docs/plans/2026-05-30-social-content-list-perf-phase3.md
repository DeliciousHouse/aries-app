# Social-content list endpoint perf — Phase 3 (list-projection + client-refetch)

## Context

`GET /api/social-content/posts` is the campaign-list / results / dashboard-home hot
path. Phases 1–2 (shipped v0.1.13.5/.6) removed double-hydration and made the
shell non-blocking, but the endpoint still **fully hydrates every job's workspace
view** to build the list. With N jobs it fans out N full `buildSocialContentWorkspaceView`
calls at concurrency 4 — each of which does a `creative_assets` Postgres query, a
dashboard-content build, a stage-payload-bundle load, and (when review state drifts)
a `saveSocialContentWorkspaceRecord` DB write. The list-screen comment itself
records the symptom: "this can take 10-40s" (`frontend/aries-v1/post-list.tsx:28`).

Phase 3 is the structural fix the prior phases deferred: return a **lightweight
projection** (the ~13 scalars + `counts` + first-3 previews the list cards actually
render) without building the full per-job workspace view, and have the detail
screen **refetch full detail client-side** when a card is opened.

## Who cares

- **Brendan / operators** — the social-content list and `/dashboard/results` are
  the daily landing screens; a 10-40s load on every visit is the single worst
  perceived-latency surface in the app.
- **Eng** — the full fan-out is the largest single contributor to the
  `ARIES_WEB_CONCURRENCY * DB_POOL_MAX` connection budget (guardrail #1); one list
  request can occupy 4 pool slots for the entire hydration window per container.

## Decisions (locked — do not re-litigate)

1. **Projection is server-side, not a client trim.** The endpoint must stop
   *computing* the full workspace view per job, not just stop serializing it.
   Trimming the JSON without removing the compute leaves the latency untouched.
2. **`pendingApprovals` accuracy is non-negotiable and stays full-fidelity.** The
   v0.1.13.7 attempt to skip the DB `creative_assets` merge under-counted approvals
   when an operator rejected a DB-only asset (see the reverted-attempt note in
   `tests/runtime-views-list-projection.test.ts`). The projection must derive
   `pendingApprovals` from a path that still honors persisted reject decisions —
   the golden oracle test (`assertListMatchesOracle`) stays green.
3. **Card fields are frozen by the current UI.** The projection returns exactly
   what `post-list.tsx` + the three view-models read (enumerated in Current State).
   The full `dashboard.{posts,assets,publishItems,calendarEvents,statuses}` arrays
   are dropped from the list payload; the detail screen fetches them on open.
4. **Detail fetch reuses the existing per-job endpoint.** Client-refetch points at
   the already-shipped `GET /api/social-content/jobs/[jobId]` (full status) —
   no new detail endpoint.
5. **Tenant-scoping and dedup semantics are preserved byte-for-byte.** Same
   first-wins dedup key (`externalPostId || name || job::<id>`), same updatedAt sort.
6. **Resumability / no fan-out regression.** Keep `processConcurrent(…, 4)`; do not
   raise concurrency (guardrail #1). The win comes from *less work per slot*, not
   more slots.

## Current State (VERIFIED — master @ v0.1.13.15)

- **Route** `app/api/social-content/posts/route.ts:17-21` — `Promise.all` of
  `listSocialContentJobsForTenant`, `listDeletedSocialContentJobsForTenant`,
  `loadTenantBrandKit`; returns `{ posts, hasMore, deletedPosts, currentBrandKitExtractedAt }`.
- **List builder** `backend/marketing/runtime-views.ts:1594-1692`
  (`listSocialContentJobsForTenant`). Default page limit 20
  (`CAMPAIGN_LIST_DEFAULT_LIMIT`, line 1592). Two-phase fan-out:
  - Phase 1 (`:1632-1644`) per job: `loadSocialContentJobRuntime` →
    `getMarketingJobStatus({runtimeDoc})` → **`buildSocialContentWorkspaceView({runtimeDoc})`**.
  - Phase 2 (`:1664-1676`) per job: `buildReviewItemsFromContext(...).filter(!approved).length`
    for `pendingApprovals`.
  - Then `buildCampaignListItem` (`:1682`) + updatedAt sort (`:1685-1689`).
- **The expensive call** `buildSocialContentWorkspaceView`
  (`backend/marketing/workspace-views.ts:1406-...`) per job does:
  `ensureSocialContentWorkspaceRecord`, `buildSocialContentDashboardProjection`,
  `getMarketingDashboardSocialContentJobContent` (`dashboard-content.ts:2902`),
  `loadStagePayloadBundle` (`:446`), a **`creative_assets` Postgres query**
  (`workspace-views.ts:1357` SQL / `:1378` `pool.query`), `buildBrandReview` /
  `buildStrategyReview` / `buildCreativeReview`, and a conditional
  `saveSocialContentWorkspaceRecord` **DB write** (`:1484`).
- **Card item shape** `RuntimePostListItem`
  (`backend/marketing/runtime-views.ts:75-114` server / `lib/api/aries-v1.ts:36-87`
  client) embeds the full `dashboard` object (`runtime-views.ts:490-496`) plus
  `previewPosts`/`previewAssets` = `dashboard.{posts,assets}.slice(0,3)` (`:488-489`)
  and `counts` (`:474-487`).
- **Who actually reads which fields:**
  - `frontend/aries-v1/view-models/post-list.ts:86-100` — scalars only
    (`id,name,summary,status,trustNote,objective,dateRange,nextScheduled,pendingApprovals,stageLabel,updatedAt`).
  - `frontend/aries-v1/view-models/results.ts:143-154` — same scalars + `status`.
  - `frontend/aries-v1/post-list.tsx:163-186` (rendered card) — reads
    **`counts.*`**, **`previewPosts`**, **`previewAssets`**, **`dashboard.assets`**
    (only for asset-by-id preview matching), `funnelStage`, `dashboardStatus`,
    `brandKitExtractedAt`, `softCancelRequestedAt`, `deletedAt`.
  - `frontend/aries-v1/generate-this-week.ts:80-95` — `executionState`,
    `approvalRequired`, `status`, `dashboardStatus`.
  - **Nothing reads** `dashboard.{posts,publishItems,calendarEvents,statuses}`
    on the list path (calendar view-model reads scheduled-posts, not these).
- **Client hook** `hooks/use-runtime-social-content.ts` — module-scoped in-flight
  dedupe (Phase-1 win) over `api.getSocialContentList()`
  (`lib/api/aries-v1.ts:427-428`). Detail today comes bundled in the list item's
  `dashboard`; there is no per-card detail fetch yet.
- **Detail endpoint already exists** `app/api/social-content/jobs/[jobId]/route.ts`
  → `handleGetMarketingJobStatus(jobId, …, {responseDialect:'social-content'})`.
- **Existing guards** `tests/runtime-views-list-projection.test.ts` (golden oracle
  + byte-identity) and `tests/social-content-list-refetch.test.ts` (hook dedupe).

## Architecture

```
Phase 3 list path (target):

Browser  /dashboard/social-content
  GET /api/social-content/posts
    -> listSocialContentJobsForTenant(tenantId)        [runtime-views.ts]
         phase1 (concurrency 4, per job):
           loadSocialContentJobRuntime(jobId)          <- 1 disk read
           getMarketingJobStatus({runtimeDoc})         <- cheap, doc-threaded
           buildListProjection({runtimeDoc, status})   <- NEW: counts + 3 previews
                + creative_assets count query          <- KEEP (approval fidelity)
         phase2 (concurrency 4): pendingApprovals from same context
    -> { posts: ListProjection[], hasMore, deletedPosts, brandKit }
                                       |
                                       v
  list cards render from projection only (no full dashboard arrays)

Browser opens a card -> /dashboard/social-content/[jobId]
  GET /api/social-content/jobs/[jobId]   (EXISTING full-status endpoint)
    -> handleGetMarketingJobStatus -> full workspace view for ONE job
                                       |
                                       v
  detail screen hydrates posts/assets/publishItems/calendar/statuses
```

The shift: full `buildSocialContentWorkspaceView` moves **off the N-job list path**
and onto the **1-job detail path** the user actually opened.

## Child issues / phases table

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| 1 | Server: `buildListProjection` (counts + previews + approvals, no full view) | P0 | 1.5d / 0.5d | none |
| 2 | API/types: split `SocialContentListItem` (projection) from `RuntimePostListItem` (detail) | P0 | 0.5d / 0.25d | 1 |
| 3 | Client: detail refetch on card open via existing `[jobId]` endpoint | P1 | 1d / 0.5d | 2 |
| 4 | Apply same projection to `listDeletedSocialContentJobsForTenant` | P1 | 0.5d / 0.25d | 1 |
| 5 | Benchmark + telemetry (full-endpoint timing, pool slots) | P1 | 0.5d / 0.25d | 1,2 |

### Phase 1 — Server list projection

**Implementation**
- Add `buildListProjection(status, runtimeDoc)` in `backend/marketing/runtime-views.ts`
  that produces the card fields **without** calling `buildSocialContentWorkspaceView`:
  - `counts` and `previewPosts`/`previewAssets` come from
    `buildSocialContentDashboardProjection(runtimeDoc, dashboardContent, …)` — the
    *projection* step only — skipping `loadStagePayloadBundle`, the
    `buildBrand/Strategy/CreativeReview` builders, and `saveSocialContentWorkspaceRecord`.
  - Keep the `creative_assets` count query (Decision 2). Extract a narrow
    `countPendingCreativeReviewsForJob(tenantId, jobId, runtimeDoc)` from the
    existing merge logic so `pendingApprovals` stays oracle-equal without building
    the full creative review payload. Prefer `SELECT count`-shaped SQL over
    selecting+mapping every asset row.
  - Drop the full `dashboard.{posts,publishItems,calendarEvents,statuses}` arrays
    from the item; keep `dashboard.assets` **only if** Phase 3 client work still
    needs it for preview matching — otherwise fold preview-asset resolution into
    `previewAssets` and drop `dashboard` entirely from the list item.
- Rewrite phase-1 of `listSocialContentJobsForTenant` (`:1632-1644`) to call
  `buildListProjection` instead of `buildSocialContentWorkspaceView`. Keep dedup
  key derivation working — derive the key from `status` + the projection's
  `post.externalPostId/name` (the dashboard projection still exposes the campaign
  identity) so first-wins ordering is unchanged.
- **Do not** raise `processConcurrent` concurrency past 4 (guardrail #1).
- Preserve the resumability contract: projection is read-only; never write runtime
  docs from the list path (the old `saveSocialContentWorkspaceRecord` side-effect is
  removed from this path, which is strictly safer).

**Acceptance**
- `tests/runtime-views-list-projection.test.ts` golden oracle stays green:
  list `pendingApprovals` == re-hydrating review-items count for every fixture,
  including the rejected-DB-only-asset case.
- A fixture-backed micro-bench (Phase 5) shows the per-job DB query count drops to
  ≤1 (the creative-assets count) and zero DB writes on the list path.
- No call to `buildSocialContentWorkspaceView`, `loadStagePayloadBundle`, or
  `saveSocialContentWorkspaceRecord` remains reachable from
  `listSocialContentJobsForTenant` (grep + test).

### Phase 2 — API / type split

**Implementation**
- In `lib/api/aries-v1.ts`, introduce `SocialContentListItem` = the projection
  (scalars + `counts` + `previewPosts` + `previewAssets` + the recycle-bin fields),
  and keep `RuntimePostListItem` as the detail-bearing type (or alias it to the
  full per-job status type). `SocialContentListResponse.posts/deletedPosts` become
  `SocialContentListItem[]`.
- Mirror the server type in `backend/marketing/runtime-views.ts`
  (`RuntimePostListItem` → emit the slimmer item). Per the
  widening-union memory: grep every `=== '<field>'` / `!== '<field>'` and field
  access site-wide when removing `dashboard.*` from the type — TS will catch
  property removal, but verify the three view-models + `post-list.tsx` +
  `generate-this-week.ts` compile and that nothing else dereferences the dropped
  arrays.

**Acceptance**
- `npm run typecheck` clean; the three view-models and `post-list.tsx` consume only
  projection fields.
- `SocialContentListResponse` no longer carries `dashboard.{posts,publishItems,calendarEvents,statuses}`.

### Phase 3 — Client detail refetch

**Implementation**
- Add `getSocialContentJob(jobId)` to the `lib/api/aries-v1.ts` client (GET
  `/api/social-content/jobs/${jobId}`) if not already present.
- On card open (the `Link` to `/dashboard/social-content/[jobId]`), the detail
  screen fetches full status from the per-job endpoint instead of relying on the
  list item's embedded `dashboard`. Reuse the existing in-flight dedupe pattern
  from `use-runtime-social-content.ts` for the detail fetch (module-scoped map keyed
  by jobId) so React 19 strict-mode double-invoke collapses to one request.
- The list cards' previews keep working from `previewPosts`/`previewAssets` — no
  detail fetch needed for the list itself.

**Acceptance**
- `tests/social-content-list-refetch.test.ts` extended: opening a card issues
  exactly one `/api/social-content/jobs/[jobId]` GET; rapid double-open dedupes.
- List render no longer depends on `dashboard.posts/publishItems/...` (visual QA in
  Brendan's dashboard — only rendered UI counts as done, per memory).

### Phase 4 — Deleted-list projection

**Implementation**
- Apply the same `buildListProjection` swap to
  `listDeletedSocialContentJobsForTenant` (`runtime-views.ts:1699-...`), preserving
  the `deletedAt/deletedBy/softCancelRequestedAt` enrichment (`:1756-1758`) and the
  cross-tenant ownership guard (`doc.tenant_id !== tenantId`, `:1714`).

**Acceptance**
- Recycle Bin renders identically; ownership guard test stays green
  (`tests/runtime-views-auth-hardening.test.ts`).

### Phase 5 — Benchmark + telemetry

**Implementation**
- Fixture-primary bench: seed K jobs under a temp `DATA_ROOT` and time
  `listSocialContentJobsForTenant` before/after, asserting reduced wall time and
  DB-query count via a query-counting `pool` stub.
- Add a single structured log line on the route with total elapsed + job count
  (mirroring the existing `[jobs-cache]` / `[marketing-hydration]` lines) so prod
  latency is observable post-deploy.

**Acceptance**
- Bench fixture demonstrates ≥ (N-1)/N reduction in per-job heavy work on the list
  path; full-endpoint timing recorded (guardrail #1 — bench the endpoint, not the
  helper).

## Testing Plan

| Test | Type | Fixture | Asserts |
|------|------|---------|---------|
| `runtime-views-list-projection.test.ts` (extend) | unit, fixture | temp DATA_ROOT jobs incl. rejected DB-only asset | projection `pendingApprovals` == oracle; counts/previews match prior output |
| `runtime-views-list-projection.test.ts` (new case) | unit | seeded jobs | no `buildSocialContentWorkspaceView` / no DB write reachable on list path |
| `social-content-list-refetch.test.ts` (extend) | unit, fetch-stub | counting fetch | card open → one `[jobId]` GET; double-open dedupes |
| `runtime-views-auth-hardening.test.ts` | unit | cross-tenant doc | deleted-list ownership guard intact |
| List-projection bench (new) | perf, fixture | K jobs + query-counting pool stub | per-job DB queries ≤1, zero writes, reduced wall time |
| Live dashboard visual QA | manual (`/pair-agent` read+write) | prod tenant | cards + Recycle Bin + detail open render correctly (only rendered UI = done) |
| `npm run verify` | gate | built-in env | regression suite green pre-push |

## Rollback

- Pure code change, no schema/migration. Revert the Phase 1 commit to restore full
  per-job hydration on the list path; the API type split (Phase 2) is the only
  shared-contract change — if reverting after Phase 3 ships, the detail screen must
  fall back to the list item's `dashboard` (keep that fallback branch until Phase 3
  has soaked one deploy). Gate the projection swap behind a process-wide flag
  (`ARIES_SOCIAL_LIST_PROJECTION=1`, default OFF until verified, then default ON in
  `docker-compose.yml`) so rollback is an env flip, not a redeploy.

## Out of Scope

- Pagination UI / infinite scroll (the `hasMore` plumbing already exists; wiring a
  "load more" control is separate).
- Caching the projection (the `[jobs-cache]` layer is a different lever; do not add
  a new cache here).
- Touching `getMarketingDashboardContentForTenant` / the tenant-wide dashboard
  aggregate path.
- Raising `processConcurrent` concurrency or `DB_POOL_MAX` (guardrail #1).
- Any change to the per-job detail endpoint's payload shape.

## Files Reference

| File | Role | Change |
|------|------|--------|
| `backend/marketing/runtime-views.ts` | list builders + item shape | add `buildListProjection`; swap phase-1; slim `RuntimePostListItem` |
| `backend/marketing/workspace-views.ts` | full view (heavy) | extract `countPendingCreativeReviewsForJob` from the creative_assets merge |
| `backend/marketing/dashboard-content.ts` | `getMarketingDashboardSocialContentJobContent` | reused by projection (projection-only step) |
| `app/api/social-content/posts/route.ts` | list route | add timing log; behind projection flag |
| `app/api/social-content/jobs/[jobId]/route.ts` | detail route | reused by client refetch (no change) |
| `lib/api/aries-v1.ts` | client types + `getSocialContentList` | add `SocialContentListItem`, `getSocialContentJob` |
| `hooks/use-runtime-social-content.ts` | list hook + dedupe | add detail-fetch dedupe pattern |
| `frontend/aries-v1/post-list.tsx` | rendered cards | consume projection; drop `dashboard.*` derefs |
| `frontend/aries-v1/view-models/{post-list,results,dashboard-home}.ts` | list view-models | verify projection-only field usage |
| `frontend/aries-v1/generate-this-week.ts` | gate logic | uses `executionState`/`approvalRequired` (keep) |
| `tests/runtime-views-list-projection.test.ts` | golden oracle | extend for projection |
| `tests/social-content-list-refetch.test.ts` | hook dedupe | extend for detail fetch |
