# Decouple Aries dashboard + auto-schedule from the Hermes publish-stage payload shape

**Date:** 2026-06-24
**Status:** REVIEWED (plan-eng-review + Codex outside voice) — one decision open (Part B path)
**Author:** Hermes Agent (for Brendan)

## Problem

Brendan intentionally split publish into a **separate Hermes publish-stage**. That stage currently emits a **strategy-shaped placeholder** — publish `primary_output` = `{stage:"strategy", content_package:[…]}` — instead of the publish-shaped artifact the old combined pipeline produced (`{stage:"publish", posts, platform_strategy, campaign_cadence / schedule, preflight_check, …}`). Verified by diffing job `mkt_c8ee6236` (new, broken) vs `mkt_c4d1ea69` (Jun 3, works).

Two Aries surfaces read that publish-stage payload shape, so both break even though the DB is correct:

1. **`/dashboard/posts` shows 0 posts / no images.** The dashboard workspace view (`buildSocialContentWorkspaceView` → `getMarketingDashboardSocialContentJobContent` → `buildSocialContentJobContentInternal`) assembles posts/assets/publishItems from **stage payloads** (`strategy/production/publishArtifactsAvailable` gates). The new shape yields nothing, so the campaign renders empty.
2. **Approved posts never auto-schedule.** `autoScheduleApprovedPostsForJob` (`hermes-callbacks.ts:1409`) hard-bails when `readWeeklySchedule(doc).length === 0` (the schedule lives in the publish payload).

**The DB is the source of truth and is correct regardless:** `synthesizePublishPostsFromContentPackage` writes the `posts` rows from the content_package, and `ingestProductionCreativeAssetsToDb` writes `creative_assets` from the production artifacts. For `mkt_c8ee6236`: 14 `posts` (7 IG + 7 FB) + 7 `creative_assets`, all publishable — FB post 220 was published live 2026-06-24 from exactly this data.

## Goal

Make the auto-scheduler (and, depending on the Part B decision, the dashboard view) work regardless of the publish-stage payload shape, **without regressing healthy jobs, in-progress states, or the projection cache invariant**.

---

## Part A — Auto-schedule fallback (small, contained) — KEEP, revised

File: `backend/marketing/hermes-callbacks.ts` → `autoScheduleApprovedPostsForJob` (L1395) + `buildAutoScheduleRows` (L1483); `backend/marketing/auto-schedule.ts` → `computeAutoScheduleSlots` (L206).

Facts confirmed in code:
- `readCampaignWindow(doc)` already defaults to `created_at + 14d`; only null on unparseable `created_at`. Window is NOT a real blocker.
- The only hard blocker is the `weeklySchedule.length === 0` early-return (L1409).
- With an empty schedule, `buildAutoScheduleRows` gives every row `recommendedDay: null`, and `computeAutoScheduleSlots` piles **all** rows onto windowStart day → spam.

**Revised change (addresses Codex review):**
1. Remove the `weeklySchedule.length === 0` early-return.
2. Add an explicit **default-cadence** path that spreads pieces by **absolute day offset**, NOT weekday-name:
   - `firstSlot = max(now + 10min, windowStart)` — the `+10min` clears the `computeAutoScheduleSlots` "default hour already passed → jumps a week" trap, so piece 1 never silently lands a week out.
   - For each post, `scheduledFor = firstSlot's date + (ordinal - 1) days` at the platform default hour (FB 13:05 ET / IG 11:00 ET), where `ordinal = parsePostNumberFromIdempotencyKey`. IG+FB of the same ordinal share a day; ordinal 1 lands first deterministically regardless of the start weekday.
   - Clamp into `[windowStart, windowEnd]`; pieces beyond the window are skipped + logged (no silent drop).
3. Keep every existing gate (variant-board await, tenant validity, no-posts-yet) and the existing flag gate at L1369 (`autoApproveMarketingPipelineEnabled() || autoScheduleOnApprovalEnabled()`) — behavior only changes for operators already opted into auto-scheduling.

Idempotent (upsert `ON CONFLICT(post_id)`); reconciler re-delivery safe. Implement the offset math as a pure helper so it's unit-testable in isolation.

---

## Part B — Dashboard "posts not showing" — DECISION OPEN (Codex re-scoped this)

The plan's original Part B ("make the dashboard DB-backed, additive fallback, no regression") **did not survive review**. Codex (outside voice) surfaced that it is materially harder and riskier than framed:

- **Projection cache invariant (P1).** `dashboard_list_projection` is "fresh" when `sourceUpdatedAt === runtimeDoc.updated_at`. DB-backed dashboard state depends on `posts` / `creative_assets` / `scheduled_posts`, which mutate **without** bumping `runtimeDoc.updated_at`. So the fast path would serve stale counts/cards unless the projection is invalidated on every such write. This is exactly the staleness class already observed on `mkt_c8ee6236` (projection "fresh" yet empty).
- **"Preserves old behavior" is false** for healthy jobs that have DB rows — their dashboard output changes too. Goldens staying green would only prove fixtures lack DB rows.
- **The posts table is not a full dashboard model.** It lacks title, summary, concept/proposal id, destination URL, strategy context, preflight state, cadence — and `publishItems`, which the UI's launch/review affordances AND `publishReadySignal` (workspace `ready_to_publish` advancement) reason over. Reconstructing all of that from thin DB rows is the hard part the original plan handwaved.
- **Circular import:** `queryProductionCreativeAssets` is private in `workspace-views.ts`, which already imports `dashboard-content.ts`. Reuse needs the helper moved to a neutral module.
- **Provenance lies:** `sourceKind` has no DB/runtime value; reusing `creative_output`/`publish_review` for DB-sourced rows corrupts the priority/provenance merge.
- **Status mapping** (`approved/scheduled/published/failed/expired` → `ready_to_publish/scheduled/live`) is underdefined; failed/expired need explicit behavior.
- **Asset-id scheme:** `posts.creative_asset_ids` may hold `img_N` (source_asset_id) OR a UUID; dashboard asset ids must resolve to previews either way.

### Three scoped options for Part B (pick one)

- **B0 — Defer; fix the Hermes publish-stage contract instead.** Brendan makes the separate publish-stage emit the publish-shaped artifact again (`posts`, `platform_strategy`, `campaign_cadence`/`schedule`). Restores BOTH the dashboard and auto-scheduling at full fidelity with zero Aries risk. Aries unchanged. Con: depends on the upstream that just regressed; no Aries safety net.
- **B1 — Narrow Aries safety net (recommended).** When the publish/production payload yields **zero** posts/assets but the DB has rows for the job, supplement ONLY (a) the asset preview thumbnails from `creative_assets` and (b) the post **counts**, so the campaign stops rendering as an empty draft — and invalidate/refresh `dashboard_list_projection` at the synthesize/ingest completion point so the fast path can't serve a stale empty. Do NOT reconstruct publishItems/cadence/provenance. Pairs with B0 for full fidelity. Bounded diff, fixes the visible symptom, keeps the projection invariant honest.
- **B2 — Full DB-backed dashboard reconstruction.** Rebuild the rich model (posts, publishItems, counts, calendar, provenance, status mapping) from DB, with projection invalidation across `posts`/`scheduled_posts`/`creative_assets`. Most resilient, but large diff, breaks the projection invariant broadly, must re-derive publish semantics from low-level rows, and **risks cementing the broken Hermes contract** (Codex). Not recommended now.

### Cross-model tension (for Brendan)

- **Original plan:** lean B2 (full DB-backed dashboard, "resilient to any publish shape").
- **Codex outside voice + this review:** prefer **B0 or B1** — fixing the Hermes contract is the simpler real fix; a full Aries reconstruction reverse-engineers publish semantics from thin rows and breaks the cache invariant.
- **Recommendation:** **A + B1** — ship the contained auto-schedule fallback (A) now, add the narrow dashboard safety net (B1) so empty campaigns stop rendering, and have Brendan restore the Hermes publish contract (B0) for full-fidelity dashboard cards. Reserve B2 only if the publish-stage cannot be made to emit the contract.

---

## What already exists (reuse, don't rebuild)

- `autoScheduleApprovedPostsForJob` + `buildAutoScheduleRows` + `computeAutoScheduleSlots` + `upsertScheduledPost` — the whole scheduling pipeline already exists and already reads posts from the DB. Part A is a fallback branch inside it, not a new system.
- `queryProductionCreativeAssets(tenantId, jobId)` (`workspace-views.ts:1381`) — job-scoped, `orphaned_at IS NULL` filtered. Reuse for B1/B2 (move to a neutral module first).
- `recomputeAndPersistPendingApprovalCount` — already the projection-refresh hook called after publish in `scheduled-dispatch`; B1/B2 extend its call sites to the synthesize/ingest completion point.
- `countPublishedPostsForJob` — already a DB count threaded into the dashboard projection (`realPublishedPostCount`); the precedent for DB-sourced dashboard numbers.

## NOT in scope

- Fixing the Hermes publish-stage shape (Brendan's domain; this is the upstream cause — option B0).
- Instagram publishing (blocked on the IG account link, #691 — connection-level, not code).
- B2 full reconstruction unless A+B1+B0 prove insufficient.
- Un-stranding the already-approved posts of `mkt_c8ee6236` (handled out-of-band: FB scheduled manually, IG connection-blocked).

## Test strategy

Part A (pure helper → unit-test heavy):
- Empty `weekly_schedule`, 14 posts (7 IG + 7 FB) → 7 distinct days, IG+FB of an ordinal paired, ordinal 1 first, none pushed past `windowEnd`. **Regression test reproducing `mkt_c8ee6236`.**
- Default-hour-already-passed (now > today's slot) → piece 1 = `now + 10min`-day, NOT next week.
- Window shorter than piece count → overflow pieces skipped + logged, no throw.
- Healthy job WITH a real `weekly_schedule` → byte-identical to today (golden).

Part B (if B1/B2):
- Job with DB posts/assets + strategy-shaped publish payload → dashboard shows assets + counts (B1) / full model (B2).
- **Projection staleness:** schedule create/delete then re-read list → counts reflect the change (proves invalidation).
- Healthy job WITH a real publish payload AND DB rows → no double-count / no regression (the "fallback preserves old behavior is false" trap).
- Failed/expired status mapping; asset-id (`img_N` vs UUID) preview resolution.

Gates: `npm run verify`, `npm run validate:social-content`, `npm run validate:execution-provider`. Live: `/dashboard/posts` for `mkt_c8ee6236` shows content; **screenshot-verify in Brendan's dashboard** (only rendered UI counts).

## Failure modes (per new codepath)

- Part A default-cadence math off-by-one / tz boundary → posts land wrong day. Covered by the pure-helper unit tests; visible (wrong calendar), not silent.
- Part A schedules a job that should have stayed manual → bounded by the existing flag gate (L1369) + idempotent upsert. Visible in `scheduled_posts`.
- Part B projection serves stale empty after DB write → **critical if B1/B2 ship without the invalidation hook.** Mitigation: invalidation is part of the B1/B2 diff, with the staleness regression test as the gate. Without it: silent stale dashboard (the current symptom, unchanged).

## Worktree parallelization

Lane A: Part A (`hermes-callbacks.ts` + `auto-schedule.ts`) — independent, shippable alone.
Lane B: Part B (`dashboard-content.ts` + neutral asset-helper module + projection invalidation) — independent module set; only starts after the B-path decision.
Lanes A and B touch disjoint modules → parallelizable. Recommend: ship A first (clear win), decide B path, then B.

## Implementation Tasks

- [ ] **T1 (P1, human ~2h / CC ~20min)** — auto-schedule — default-cadence fallback when `weekly_schedule` empty (absolute day-offset, +10min trap guard, window clamp) as a pure helper.
  - Surfaced by: Architecture + Codex — `autoScheduleApprovedPostsForJob` bails on empty schedule; ordinal→weekday mapping is start-weekday-dependent + default-hour trap.
  - Files: `backend/marketing/hermes-callbacks.ts`, `backend/marketing/auto-schedule.ts`
  - Verify: new unit tests + `npm run validate:social-content`
- [ ] **T2 (P2, human ~30min / CC ~10min)** — auto-schedule — regression + edge tests (reproduce `mkt_c8ee6236`, default-hour-passed, window overflow, healthy-schedule golden).
  - Files: `tests/marketing/*`
- [ ] **T3 (P?, gated on B decision)** — dashboard — B1 narrow safety net (DB asset preview + counts when payload empty) + projection invalidation at synthesize/ingest; move `queryProductionCreativeAssets` to a neutral module.
  - Surfaced by: Codex — projection invariant, circular import, rich-model gap.
  - Files: `backend/marketing/dashboard-content.ts`, new helper module, `backend/marketing/workspace-views.ts`
  - Verify: staleness regression test + `npm run verify`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | Part A revised (day-offset, trap guard); Part B re-scoped to B0/B1/B2 |
| Outside Voice | Codex (high effort) | Independent 2nd opinion | 1 | issues_found | 6 substantive: projection invariant, rich-model gap, false "no-regression", weekday-map bug, circular import, contract-cementing risk |

- **CODEX:** Flagged that Part B (full DB-backed dashboard) breaks the `dashboard_list_projection` freshness invariant (state mutates without bumping `runtimeDoc.updated_at`), reconstructs publish semantics from a thin `posts` table missing `publishItems`/cadence/provenance, and risks cementing the broken Hermes contract. Flagged Part A's ordinal→weekday mapping as start-weekday-dependent + exposed to the `computeAutoScheduleSlots` default-hour-passed week-jump.
- **CROSS-MODEL:** Original plan leaned B2 (full DB reconstruction). Codex argues B0 (fix Hermes contract) / B1 (narrow Aries net). Both agree Part A is sound once the day-distribution is fixed. Recommendation folded in: **A + B1 now, B0 by Brendan, B2 only if needed.**
- **VERDICT:** Part A CLEARED to implement. Part B NOT cleared — one decision open (B0 / B1 / B2).

**UNRESOLVED DECISIONS:**
- Part B path: B0 (defer, fix Hermes contract) / B1 (narrow Aries safety net — recommended) / B2 (full DB-backed reconstruction).
