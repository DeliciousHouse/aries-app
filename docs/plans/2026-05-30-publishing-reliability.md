# Publishing reliability — creative_asset_ids population + Meta failure taxonomy

**Status:** Open. Two bundled publishing-reliability items from `TODOS.md`.
**Author:** Staff eng plan, 2026-05-30.
**Related:**
- `app/api/internal/publishing/scheduled-dispatch/route.ts` (per-post media resolver + stale comment)
- `backend/integrations/meta-publishing.ts` (Meta Graph publish + `MetaPublishError`)
- `backend/marketing/synthesize-publish-posts.ts`, `backend/integrations/publish-verification.ts` (existing `creative_asset_ids` writers)
- Prior art: PR `d7fda3a` (populate `creative_asset_ids` in publish stage), `e7b0956` (merge into Phase 2 scheduling)

---

## Context

Two adjacent reliability gaps in the Meta publishing path, bundled because they touch the same files and the same operator failure mode (the wrong image goes out, or a post silently dies with no actionable signal).

1. **`posts.creative_asset_ids` is the per-post media link** that lets `resolveMediaUrls` pick the *exact* image for a scheduled post instead of falling back to a job-scoped join that returns *every* image the weekly job produced. The write paths now exist in code (shipped via `d7fda3a` / `e7b0956`), but the resolver still carries a stale comment asserting "no Aries code populates it yet — every prod `posts` row has `creative_asset_ids = '{}'`" (`scheduled-dispatch/route.ts:43-48`), and **existing prod rows written before those PRs are still `'{}'`**. Until the data is backfilled and the manual schedule path is verified to carry ids forward, a multi-image weekly job can still publish the wrong creative.

2. **Meta publish failures already carry a 2-axis model** (`retryable` + `outcomeUnknown`) but there is **no explicit auth class**. `oauth_token_missing` / `external_account_missing` are surfaced as generic `retryable:false` errors — indistinguishable from a malformed-request 400 — so an operator whose token expired gets "publish failed" with no "reconnect your account" signal, and the worker treats it as terminal-but-opaque. We want a single, named transient / permanent / auth taxonomy with distinct retry + surface behavior.

## Who cares

- **Brendan (single-tenant prod operator):** publishing the wrong image to a live Meta account is a brand-visible mistake; a silent "publish failed" with no reconnect prompt is a dead end.
- **The scheduled-posts worker** (`scripts/automations/scheduled-posts-worker.mjs`): needs a clean retryable/terminal signal so it neither hammers a permanently-broken post nor abandons a transient one.
- **Future analytics / Honcho performance loop:** depends on `creative_asset_ids` to attribute performance back to a specific creative.

## Decisions (locked — do not re-litigate)

- **D1.** `creative_asset_ids` is `TEXT[]`, entries match **either** `creative_assets.id` (uuid text) **or** `creative_assets.source_asset_id` (`img_1`, …). The resolver already joins on both forms (`scheduled-dispatch/route.ts:85-86`); do not change the column type or the dual-form contract.
- **D2.** The job-scope fallback in `resolveMediaUrls` (`route.ts:89-93`) **stays** as a safety net for legacy rows. We do not remove it; we make the populated path primary and verify the fallback only fires for genuinely-empty rows.
- **D3.** The Meta failure taxonomy is **derived**, not stored: it is computed from the existing `MetaPublishError` fields. We do **not** add a new DB column for it. `outcomeUnknown` already encodes the never-auto-retry class and must keep its exact current semantics (a 2xx-accepted publish with no confirmed id is NOT safe to retry).
- **D4.** The Graph publish calls (`/feed`, `/media_publish`, `/photo_stories`) have **no idempotency primitive** — closing the double-publish window is explicitly out of scope (documented at `scheduled-dispatch/route.ts:185-201`). The taxonomy must never auto-retry an `outcome_unknown` failure.
- **D5.** Backfill is a **one-shot script run against prod**, idempotent and tenant-scoped, gated behind a dry-run default. It does not run in `init-db.js` (schema migrations only).
- **D6.** No new env flag for the taxonomy. The `auth` class changes the *response shape* (a `needs_reconnect` reason) but not the retry policy beyond what `retryable:false` already does — it is additive and safe to ship un-gated.

## Current State (VERIFIED)

### Item 1 — creative_asset_ids

- **Schema:** `posts.creative_asset_ids TEXT[] NOT NULL DEFAULT '{}'` — `scripts/init-db.js:432`.
- **Writers that already populate it (on master):**
  - `backend/marketing/synthesize-publish-posts.ts:350,362` — autonomous-mode synthesized posts set `creativeAssetIds = assetId ? [assetId] : []` from the ingested `creative_assets` (post_number → Nth asset by `source_asset_id`).
  - `backend/integrations/publish-verification.ts:159-182` — `persistPublishedPost` normalizes and inserts `creative_asset_ids` (drops blanks/dupes; empty array keeps the column default).
  - `app/api/marketing/jobs/[jobId]/publish-instagram/handler.ts:108` and `.../publish-facebook/handler.ts:104` — capture `publishedAssetId` from the approved creative and thread it into the persisted post.
- **Reader:** `resolveMediaUrls` (`scheduled-dispatch/route.ts:63-118`) joins `posts → creative_assets` on the per-post ids (`route.ts:82-87`) with a job-scope fallback when the array is empty (`route.ts:89-93`).
- **The gap (VERIFIED):**
  - The resolver comment at `scheduled-dispatch/route.ts:43-48` still asserts "no Aries code populates it yet — every prod `posts` row has `creative_asset_ids = '{}'`." **Stale** — contradicted by the writers above (PR `d7fda3a` is an ancestor of `master`).
  - **Rows written before `d7fda3a` are still `'{}'`** and rely on the fallback; a backfill has never run. (Could not query prod from this worktree — `psql` not installed; treat backfill as required, verify counts at run time.)
  - The **manual social-content schedule path** (`app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts:211` → `upsertScheduledPost`) reads an existing `posts` row and creates a `scheduled_posts` row; it does **not** write `creative_asset_ids` itself — it inherits whatever the `posts` row already had. So any post created by a path that did not set the column publishes via the fallback.

### Item 2 — Meta failure taxonomy

- **Error type:** `MetaPublishError` (`meta-publishing.ts:50-76`) carries `code`, `status`, `retryable` (default false), `outcomeUnknown` (default false).
- **Existing classifier:** `classifyMetaPublishFailure` (`meta-publishing.ts:99-104`) returns `'definitely_never_posted' | 'outcome_unknown'` — only the publish-acceptance axis.
- **All thrown codes (VERIFIED, `meta-publishing.ts`):**
  | Code | status | retryable | outcomeUnknown | True nature |
  |---|---|---|---|---|
  | `unsupported_provider` | 400 | – | – | permanent |
  | `invalid_scheduled_for` | 400 | – | – | permanent |
  | `missing_content` | 400 | – | – | permanent |
  | `instagram_media_required` | 400 | – | – | permanent |
  | `story_single_media_required` | 400 | – | – | permanent |
  | `oauth_token_missing` | 409 | – | – | **auth** (no class today) |
  | `external_account_missing` | 409 | – | – | **auth** (no class today) |
  | `*_scheduled_publish_not_supported` | 409 | – | – | permanent |
  | `graph_network_error` | 502 | true | – | transient |
  | `graph_rate_limited` | 429 | true | – | transient (after MAX_429_RETRIES) |
  | `graph_api_error` (5xx) | 5xx | true | – | transient |
  | `graph_api_error` (4xx) | 4xx | false | – | permanent |
  | `instagram_container_timeout` | 504 | true | – | transient |
  | `instagram_container_failed` | 422 | false | – | permanent |
  | `*_publish_missing_id` | 502 | false | **true** | outcome-unknown |
- **Consumers:**
  - `publish-facebook/handler.ts:289-344` and `publish-instagram/handler.ts:294-344` — branch on `classifyMetaPublishFailure` for the `needs_manual_reconciliation` (outcome-unknown) case, then fall through to a generic `{status:'error', reason: error.code}` for everything else. **No auth-specific branch.**
  - `scheduled-dispatch/route.ts:231-244` — maps `MetaPublishError.retryable` straight onto the per-platform result; auth failures (`retryable:false`) become opaque terminal failures.
  - `scheduled-posts-worker.mjs:234` — `retryable = result ? result.retryable !== false : true`; drives `pending` (retry) vs `failed` (terminal). It never learns a failure was auth-related, so a tenant whose token expired gets N posts silently marked `failed` with no reconnect signal.

## Architecture

```
                         ┌─────────────────── Item 1: per-post media link ───────────────────┐
 publish handlers ──┐    │                                                                    │
 (fb / ig)          │    │   posts.creative_asset_ids  (TEXT[]: uuid OR source_asset_id)      │
 synthesize-posts ──┼──► │        ▲ writers (live on master)        │                          │
 publish-verif.  ───┘    │        │                                 ▼                          │
                         │   [BACKFILL one-shot]            resolveMediaUrls(postId,tenant)    │
 manual schedule ───────►│   inherits row's ids       ┌── per-post join (ids present) ◄── primary
   (upsertScheduledPost) │                            └── job-scope join (ids empty)  ◄── fallback (D2)
                         └────────────────────────────────────────────┬───────────────────────┘
                                                                       │ signed media_urls
                                                                       ▼
 scheduled-posts-worker ──POST──► /api/internal/publishing/scheduled-dispatch ──► publishToMetaGraph
        ▲   retry/terminal                                  │                          │
        │                                                   │              throws MetaPublishError
        │   ┌──────────── Item 2: failure taxonomy ─────────┘                          │
        └───┤ classifyMetaPublishFailureKind(error) ──► 'transient' | 'permanent' |    │
            │   'auth' | 'outcome_unknown'                                              │
            │     transient  → retryable, worker re-claims                              │
            │     permanent  → terminal 'failed'                                        ◄┘
            │     auth       → terminal 'failed' + reason:'needs_reconnect' surfaced
            │     outcome_unknown → claim left, never retried (D4)
            └────────────────────────────────────────────────────────────────────────
```

## Child issues / phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|---|---|---|---|
| P1 | Backfill `creative_asset_ids` on prod + verify manual schedule path | P1 | M / S | none |
| P2 | Make populated path primary: remove stale comment, populated-first test | P1 | S / S | P1 |
| P3 | Meta failure taxonomy: add `auth` + named transient/permanent classifier | P2 | S / S | none (parallel to P1/P2) |
| P4 | Wire taxonomy into handlers + worker surface (`needs_reconnect`) | P2 | S / S | P3 |

---

### P1 — Backfill + verify the manual schedule path

**Implementation**

1. Write `scripts/backfill-creative-asset-ids.mjs` (one-shot, dry-run default, **not** wired into `init-db.js` per D5). For each `posts` row where `array_length(creative_asset_ids,1) IS NULL` AND `job_id IS NOT NULL`, resolve the job's `creative_assets` (`source_job_id = posts.job_id`, `source_type='generated_by_aries'`, ordered by `source_asset_id`) and:
   - If the job produced exactly one asset, set `creative_asset_ids = ARRAY[<that asset's source_asset_id>]` — non-regressive vs the current fallback, and now exact.
   - If the job produced multiple assets, the post→asset mapping is ambiguous for legacy rows (no `post_number` recorded on the row). **Do not guess.** Log these rows and leave them on the fallback. Report the count.
   - Tenant-scope every query (`WHERE tenant_id = $1`); iterate tenants. Respect guardrail #1 — sequential per-tenant, no `Promise.all` fan-out over the pool.
2. Run `--dry-run` first, capture before/after counts (`total`, `populated`, `empty`, `ambiguous_multi`). Then run for real.
3. Verify the manual schedule path: confirm `upsertScheduledPost` (`backend/social-content/scheduled-posts.ts`) and the schedule route (`schedule/route.ts:211`) read a `posts` row that already has `creative_asset_ids` set (it does for posts created by the synthesize / publish-verification writers). Add an assertion-style check; if a post-creation path is found that does NOT set the column, file it as a P1 follow-up (do not expand scope here).

**Acceptance**

- Dry-run report prints `total / populated / empty / ambiguous_multi` counts for prod.
- After the real run, every single-asset legacy row has a non-empty `creative_asset_ids`; multi-asset ambiguous rows are logged and untouched.
- Re-running the script is a no-op (idempotent: it only touches `array_length IS NULL` rows).
- A scheduled post for a multi-image job, when dispatched, resolves to its own image (verified via `resolveMediaUrls` returning the per-post asset, not the whole job set).

### P2 — Make the populated path primary

**Implementation**

1. Delete the stale "no Aries code populates it yet — every prod `posts` row has `creative_asset_ids = '{}'`" comment block (`scheduled-dispatch/route.ts:43-48`); replace with a 2-line note that the column is populated by the publish/synthesize writers and the job-scope join is a legacy/empty-row fallback (D2).
2. No SQL change to `resolveMediaUrls` — the join already prefers populated ids. Keep the fallback (D2).
3. Add a regression test asserting the **populated path is taken** (per-post asset returned) and the fallback only fires when the array is empty. Extend `tests/scheduled-dispatch-media-resolution.test.ts` / `tests/publish-creative-asset-ids.test.ts` (both already exercise this seam via the injectable `DispatchQueryable`).

**Acceptance**

- `npm run validate:banned-patterns` passes (confirm the deleted comment is not itself a banned literal first).
- New test proves: row with ids → per-post join used; row with `'{}'` → job-scope fallback used. Both assert exact returned URLs.

### P3 — Failure taxonomy classifier

**Implementation**

1. In `meta-publishing.ts`, add `export type MetaPublishFailureKind = 'transient' | 'permanent' | 'auth' | 'outcome_unknown';`
2. Add `export function classifyMetaPublishFailureKind(error: unknown): MetaPublishFailureKind`:
   - `outcome_unknown` first if `error instanceof MetaPublishError && error.outcomeUnknown` (preserve D3 / D4 semantics).
   - `auth` if `error.code === 'oauth_token_missing' || error.code === 'external_account_missing'`.
   - `transient` if `error.retryable === true`.
   - `permanent` otherwise (including non-`MetaPublishError` throws). Note: a bare network throw is already wrapped as `graph_network_error` (retryable) before it reaches a caller, and the dispatch route independently treats raw non-Meta throws as retryable at `route.ts:237` — keep that route behavior; this classifier is for `MetaPublishError`s.
3. Keep the existing `classifyMetaPublishFailure` (2-class) for the outcome-unknown branch consumers — do **not** rename it (avoids touching the handler reconciliation branches). The new function is additive.
4. Unit-test every code in the table above maps to the expected kind.

**Acceptance**

- `tests/meta-publishing.test.ts` extended: a parametrized test over each known code asserts `classifyMetaPublishFailureKind` returns the kind from the Current State table.
- `outcome_unknown` still wins over `transient`/`permanent` when `outcomeUnknown` is set (a `*_publish_missing_id` at status 502 is `outcome_unknown`, never `transient`).
- `oauth_token_missing` and `external_account_missing` return `auth`.

### P4 — Wire taxonomy into handlers + worker

**Implementation**

1. In `publish-facebook/handler.ts` and `publish-instagram/handler.ts`, after the existing `outcome_unknown` branch (lines ~289/294), add an `auth` branch using `classifyMetaPublishFailureKind`: return `{status:'error', reason:'needs_reconnect', code: error.code, message: <reconnect-your-Meta-account copy>}` with the existing `error.status` (409). This is a distinct, operator-actionable signal — not a generic `publish_failed`.
2. In `scheduled-dispatch/route.ts`, when building each per-platform result (lines ~231-244), include the failure kind: `{provider, ok:false, error, retryable, kind}`. Keep `retryable` exactly as today (auth stays `retryable:false` → terminal). The `kind` is informational so the worker can surface it.
3. In `scheduled-posts-worker.mjs`, thread `kind` from the dispatch result through `normalizeResults` (line ~228-236) onto the per-platform `scheduled_post_dispatches.error_message` (e.g. prefix `auth: token expired — reconnect required`) so an operator inspecting a stuck `failed` row sees *why*. No retry-policy change — auth is already terminal; this is a surface-only improvement.

**Acceptance**

- Auth failure (mock `oauth_token_missing`) through a publish handler returns `reason:'needs_reconnect'` at status 409 — verified in `tests/smoke-meta-publish.test.ts` or a new handler test.
- Dispatch route includes `kind` on each per-platform result; transient still maps to `pending`/retry, auth + permanent to terminal `failed`.
- Worker writes the auth reason into `scheduled_post_dispatches.error_message`; a terminal `failed` row for an expired token is distinguishable from a malformed-request `failed` row.
- `outcome_unknown` path is byte-for-byte unchanged (claim left in place, no retry) — regression-asserted.

## Testing Plan

Fixture-primary; the publish seam is fully injectable (`DispatchQueryable`, `fetchImpl`, mock pools) so no live Meta calls.

| Layer | Test | Type | Asserts |
|---|---|---|---|
| Backfill | `tests/backfill-creative-asset-ids.test.ts` (new) | fixture (mock pool) | single-asset row populated; multi-asset row untouched + counted; re-run no-op |
| Resolver | `tests/scheduled-dispatch-media-resolution.test.ts` (extend) | fixture | populated ids → per-post join; `'{}'` → job-scope fallback; exact URLs |
| Resolver | `tests/publish-creative-asset-ids.test.ts` (existing, keep green) | fixture | writers populate the column; resolver scopes per-post |
| Classifier | `tests/meta-publishing.test.ts` (extend) | unit | every code → expected kind; `outcome_unknown` precedence; auth codes |
| Handlers | `tests/smoke-meta-publish.test.ts` (extend) | fixture (fetch mock) | `auth` → `needs_reconnect`/409; transient → retryable; outcome-unknown → `needs_manual_reconciliation` unchanged |
| Worker | worker normalize test (extend existing) | unit | `kind` threaded; retry policy unchanged; auth reason in `error_message` |
| Live-DB | `tests/marketing/synthesize-publish-posts-live-db.test.ts` (keep green) | live PG | synthesized posts carry `creative_asset_ids` |
| Gate | `npm run verify` + `npm run validate:banned-patterns` | suite | no banned literals reintroduced; fast regression green |

**Run before pushing:** `npm run verify` (CLAUDE.md pre-push gate). The backfill script is run manually against prod, not in CI — verify dry-run counts first (treat-as-production guardrail).

## Rollback

- **P1 (backfill):** data-only. Rollback = nothing to revert in code; the script never deletes ids, only fills `NULL`-length rows. If a populated id is wrong, the resolver's job-scope fallback (D2) does not re-engage for a populated row — to revert a specific tenant, `UPDATE posts SET creative_asset_ids = '{}' WHERE tenant_id = $1 AND <condition>` re-enables the fallback. Capture the dry-run report so the affected row set is known.
- **P2:** comment + test only; `git revert` is clean, no behavior change to the SQL.
- **P3:** additive function; unused if P4 not shipped. Revert is isolated.
- **P4:** the `needs_reconnect` branch and `kind` field are additive. Reverting restores the generic `{reason: error.code}` response. Retry policy never changed, so the worker behaves identically on revert. The `outcome_unknown` path is untouched by design and is the highest-risk-if-broken surface — guarded by an unchanged regression test.

## Out of Scope

- Closing the double-publish window (no Meta-side idempotency primitive; documented at `scheduled-dispatch/route.ts:185-201`) — D4.
- Auto-refreshing expired Meta tokens / triggering re-consent flow — `auth` class only *surfaces* the need to reconnect; the OAuth reconnect UI is a separate workstream.
- Video / Reels / Stories publishing surface changes (see MEMORY: Meta publish surface).
- Performance-metrics fetch loop (covered by `docs/plans/2026-05-24-honcho-performance-insights-integration.md`).
- Multi-asset legacy-row disambiguation (no `post_number` on legacy rows) — backfill leaves these on the fallback rather than guessing.
- Changing the `creative_asset_ids` column type or the dual-id-form join (D1).

## Files Reference

| File | Role | Touched by |
|---|---|---|
| `scripts/init-db.js:432` | `posts.creative_asset_ids` schema | read only |
| `scripts/backfill-creative-asset-ids.mjs` | one-shot backfill (new) | P1 |
| `app/api/internal/publishing/scheduled-dispatch/route.ts:43-48,63-118,231-244` | resolver + stale comment + per-platform result | P2, P4 |
| `backend/marketing/synthesize-publish-posts.ts:350,362` | autonomous writer (verify) | P1 (read) |
| `backend/integrations/publish-verification.ts:159-182` | publish-verification writer (verify) | P1 (read) |
| `app/api/marketing/jobs/[jobId]/publish-facebook/handler.ts:104,289-344` | writer + error branches | P4 |
| `app/api/marketing/jobs/[jobId]/publish-instagram/handler.ts:108,294-344` | writer + error branches | P4 |
| `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts:211` | manual schedule path (verify inherits ids) | P1 (verify) |
| `backend/integrations/meta-publishing.ts:50-104` | `MetaPublishError` + classifiers | P3 |
| `scripts/automations/scheduled-posts-worker.mjs:228-236` | retry/terminal + surface | P4 |
| `tests/publish-creative-asset-ids.test.ts` | resolver + writer regression | P2 |
| `tests/scheduled-dispatch-media-resolution.test.ts` | resolver regression | P2 |
| `tests/meta-publishing.test.ts` | classifier unit | P3 |
| `tests/smoke-meta-publish.test.ts` | handler surface | P4 |
| `tests/marketing/synthesize-publish-posts-live-db.test.ts` | live-PG writer | P1 (keep green) |
