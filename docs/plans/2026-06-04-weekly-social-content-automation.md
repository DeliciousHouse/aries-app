<!-- plan: weekly social-content automation -->
# Weekly Social-Content Automation (human-in-the-loop, both platforms)

## Problem

The "weekly social content" workflow does not actually deliver content on a cadence to a tenant's Instagram + Facebook. Two things are missing, and the only existing automation is the dangerous all-or-nothing autonomous flag.

1. **Nothing auto-triggers a weekly job.** There is no cron/scheduler/completion-hook anywhere (verified: in-app code, docker workers, host crontab, system cron, GitHub Actions). A `weekly_social_content` job only starts via onboarding's first job or a manual `/api/marketing/jobs` POST. So "it just runs every week" was never built.
2. **Approved content does not auto-schedule unless the unsafe flag is on.** The only auto-scheduler, `autoScheduleApprovedPostsForJob` (`backend/marketing/hermes-callbacks.ts:1369`, invoked at `:1343`), is gated solely by `ARIES_AUTO_APPROVE_MARKETING_PIPELINE` — the flag that also auto-approves the publish gate with **no human review**. With approval-gating ON (the safe setting), approved posts strand (36 stranded IG posts observed for tenant 15). The auto-scheduler already covers both IG + FB via `PLATFORM_POSTING_DEFAULTS` (staggered).

The publish back-half already works: `scheduled-posts-worker` (host cron every 1m + docker service every 60s) drains `scheduled_posts` (`dispatch_status='pending'`, `scheduled_for<=now`) and publishes due posts to both platforms via `/api/internal/publishing/scheduled-dispatch`. The gap is purely upstream: nothing fills the queue (without the unsafe flag), and nothing triggers the weekly job.

## Goal

"Generate weekly → the operator reviews/approves → it auto-posts to both Instagram and Facebook," with a human in the loop and **without** `ARIES_AUTO_APPROVE_MARKETING_PIPELINE`. Ship both pieces flag-gated, default OFF, staged on one test tenant first.

## Non-goals

- Stories / Reels / video publishing (separate path, gated by `ARIES_VIDEO_PUBLISH_ENABLED`, out of scope).
- A tenant-facing scheduling UI (operator config via DB/admin for now; UI is a follow-up).
- Removing or changing `ARIES_AUTO_APPROVE_MARKETING_PIPELINE` (it stays default-OFF; this feature is the safe alternative).
- Per-post cadence customization beyond day-of-week + hour + timezone.

## Piece A — Auto-schedule on publish approval (foundation, do first)

When the **publish stage** of a job becomes approved (human click OR the auto-approve path), schedule that job's already-approved posts across both platforms — decoupled from the unsafe flag.

- **New flag:** `ARIES_AUTOSCHEDULE_ON_APPROVAL` (default OFF). Treats `1/true/yes/on` as enabled (match existing flag parsers).
- **Hook:** call `autoScheduleApprovedPostsForJob(doc)` from the point where a publish-stage approval is recorded, when the flag is on. Two entry paths must converge on one helper:
  - Human path: `app/api/social-content/jobs/[jobId]/approve/route.ts` → `approveSocialContentJob` (`orchestrator.ts`) → after the publish-stage approval resolves.
  - Auto path: the existing `:1343` call already fires under the unsafe flag; leave it, and additionally fire under the new flag.
- **Scope guard (safety):** only schedule when the approval is for the **publish** stage and the job's posts are `published_status='approved'`. Never schedule un-reviewed content. This is the load-bearing invariant.
- **Idempotency:** `upsertScheduledPost` is `ON CONFLICT (post_id) DO UPDATE`, so re-firing is safe (re-schedule, not duplicate). Confirm the per-platform `scheduled_post_dispatches` idempotency prevents double-publish.
- **Coverage:** unchanged — `autoSchedulePosts` already schedules every post×platform from `PLATFORM_POSTING_DEFAULTS` (IG + FB, staggered), so both accounts are covered once this fires.

**Outcome:** with `ARIES_AUTOSCHEDULE_ON_APPROVAL=1` and `ARIES_AUTO_APPROVE_MARKETING_PIPELINE=0`, the operator approves the publish stage and the week's posts auto-schedule + publish to both accounts — human-in-the-loop and hands-off.

## Piece B — Weekly trigger worker

A standing worker that auto-starts a `weekly_social_content` job for each opted-in tenant on a cadence.

- **New worker:** `scripts/automations/weekly-job-trigger-worker.ts`, mirroring the reconciler/reaper pattern: spawned by `start-runtime.mjs` (sibling of the Next.js cluster) gated by an env flag, OR a standalone `docker-compose.yml` service (decision below). Self-schedules on an interval (e.g. every 15 min) and only acts when a tenant is due.
- **New flag:** `ARIES_WEEKLY_TRIGGER_ENABLED` (default OFF).
- **New table `marketing_schedule`:** `tenant_id (PK)`, `cadence` (`weekly`), `day_of_week` (0-6), `hour` (0-23), `timezone` (IANA), `enabled` (bool), `last_triggered_at` (timestamptz null), `created_at`, `updated_at`. Migration under `migrations/`.
- **Active-tenant predicate:** `enabled=true` AND onboarding complete AND a usable brand_url in the business profile.
- **Due logic + dedup:** a tenant is "due" when now (in tenant tz) is at/after its `day_of_week`+`hour` slot AND `last_triggered_at` is in a prior cadence window. Set `last_triggered_at` transactionally **before** submitting (claim-then-act) so a crash/restart can't double-trigger. One job per tenant per week.
- **Job start:** call the same entrypoint a manual generate uses (`startSocialContentJob` / `handlePostMarketingJobs`) with `{tenantId, jobType:'weekly_social_content', brand_url from business profile}`.
- **Interaction with Piece A:** the triggered job runs research → strategy → production → publish, pausing at each approval gate (auto-approve OFF). The operator approves; Piece A schedules + publishes. So Piece B depends on Piece A for the content to actually go out.

## Reaper interaction (known issue)

With `ARIES_AUTO_APPROVE_MARKETING_PIPELINE=0`, a job pauses at an approval gate; the stale-run reaper reaps `awaiting_approval` gates past the stage threshold (strategy = 5 min). A weekly-triggered job will pause and can be reaped before the operator approves. Options:
1. Make the reaper skip `awaiting_approval` states (the proper fix; small change in `backend/marketing/stale-run-reaper.ts`).
2. Operationally run with `ARIES_REAPER_ENABLED=0` (loses stale-job cleanup).

This plan recommends (1) as a prerequisite/companion change so the human-in-the-loop flow is viable: the reaper should reap *stalled* runs, not runs *correctly waiting for a human*.

## Flags (all default OFF)

- `ARIES_AUTOSCHEDULE_ON_APPROVAL` — Piece A.
- `ARIES_WEEKLY_TRIGGER_ENABLED` — Piece B worker.
- (companion) reaper change to not reap `awaiting_approval` — behavior change, gate if risky.

## Test plan

- Unit: flag parsers; the due/dedup logic (table-driven across timezones, last_triggered windows, day/hour boundaries); the publish-approval scope guard (only publish-stage + approved posts schedule).
- Live-DB: `marketing_schedule` migration + the claim-then-act dedup under a simulated double-tick (no duplicate jobs).
- Integration: Piece A fires on a manual publish-stage approval with the flag on → both IG + FB scheduled_posts rows appear; idempotent on re-approval.
- E2E (single test tenant): enable both flags for ONE tenant, let the worker trigger, approve through the dashboard, confirm posts schedule and the scheduled-posts-worker publishes to both accounts (rendered on the live accounts is the only pass signal).

## Rollout

1. Land Piece A behind `ARIES_AUTOSCHEDULE_ON_APPROVAL` (default OFF). Verify on tenant 15 by approving a job with the flag on in prod env only.
2. Land the reaper companion change.
3. Land Piece B worker + `marketing_schedule` (default OFF). Seed ONE test tenant row, enable `ARIES_WEEKLY_TRIGGER_ENABLED`, watch one cycle end-to-end.
4. Widen to more tenants by inserting `marketing_schedule` rows.

## What already exists (reuse, don't rebuild)

- `autoScheduleApprovedPostsForJob` + `autoSchedulePosts` + `PLATFORM_POSTING_DEFAULTS` — both-platform scheduling, staggered timing. Piece A just re-triggers it on approval.
- `upsertScheduledPost` (`ON CONFLICT(post_id)`) — idempotent queue writes.
- `scheduled-posts-worker` + `/api/internal/publishing/scheduled-dispatch` — the publish back-half (works).
- `startSocialContentJob` / `handlePostMarketingJobs` — job start entrypoint.
- start-runtime sibling-worker pattern (reconciler/reaper) + docker-compose worker services — the worker scaffolding.

---

## CEO Review (Phase 1) — Claude subagent (Codex voice: timed out / unavailable)

Consensus: single-voice (Codex CEO exit 124 timeout → [subagent-only]).

Top findings:
- **[CRITICAL] Unvalidated premise.** The plan assumes operators want cron-generated weekly content they then review. The one real datapoint — 36 stranded approved IG posts on tenant 15 — is at least as consistent with "operators approve and never come back to ship" as with "scheduler broken." If operators don't reliably return to approve, a weekly trigger manufactures stale-draft backlog, not shipped content.
- **[HIGH] Bottleneck is the approval click, not the trigger.** Piece A ("approve → both platforms scheduled") is the high-value, on-strategy half. Piece B (cron trigger + new table + dedup + tz math + reaper change) spends most of the eng budget on the ~10%-value half.
- **[HIGH] Per-tenant config via raw DB inserts is a 6-month regret.** At 50-tenant scale, hand-editing `marketing_schedule` for every cadence/tz change is an ops liability; a typo silently mis-fires a customer's whole cadence. If Piece B ships, a minimal day/hour/tz control is MVP, not follow-up.
- **[HIGH] Cron generation risks shipping mediocre content on autopilot** given recent generation-quality instability (brand-color, stale gateway). Add a quality/brand-kit-freshness gate + a draft-expiry sweep (also fixes the 36-stranded symptom).
- **[MEDIUM] Reaper-skip-awaiting_approval is under-scoped** — don't make it un-reapable (reintroduces the silent-wedge failure the reaper exists to catch); use a long separate threshold (~7d) + alert.
- **[MEDIUM] Dismissed alternative: notify-and-pull.** A weekly nudge ("your week is ready to generate — review it") with a one-click generate gets cadence + habit without unattended generation, a new table, or the reaper problem — and surfaces the do-they-click data.
- **[MEDIUM] Idempotency gap.** claim-then-act on `last_triggered_at` prevents double-fire but, on submit failure after the timestamp commits, silently skips a tenant's whole week. A missed week must be loud.
- **[MEDIUM] Competitive drift.** A cron+scheduler-table pulls toward the commoditized Buffer/Later category (where the deferred UI puts Aries behind); Aries' wedge is the agentic pipeline. Piece A serves that; Piece B drifts.

Recommendation: **Ship Piece A. Hold Piece B** until there is one number — publish-approval rate/latency on the manual flow. If operators reliably approve, a notification nudge likely beats a cron; if they don't, Piece B makes the backlog worse.

---

## Premise gate decision (operator): BUILD BOTH A + B, with review risk-fixes folded in

- Quality gate before any auto-trigger: skip enqueue if brand kit is stale/unenriched.
- Reaper companion: do NOT make awaiting_approval un-reapable — use a long separate threshold (~7d) + an alert, not a silent reap.
- Submit-failure handling: a missed week must be LOUD (roll back last_triggered_at or record last_attempt/last_success split + alert).
- Minimal tenant day/hour/tz control is part of Piece B MVP (not raw-SQL-only).
- Draft-expiry sweep to stop stranded approvals accumulating (addresses the 36-stranded symptom).

---

## Eng Review (Phase 3) — Claude subagent (Codex voice: auth invalidated / unavailable)

Consensus: single-voice ([subagent-only]; Codex 401 token_invalidated). Findings auto-adopted (mechanical corrections; eng-phase principles P5 explicit + P3 pragmatic).

### REVISED DESIGN (supersedes the Piece A / Piece B sections above)

**Piece A is a ~1-line change, NOT an orchestrator hook.** The orchestrator approve path (`approveSocialContentJob` → `advancePublishStage`, orchestrator.ts:1432) returns early (`kind==='submitted'`, ~:1498); the job is NOT complete and no `posts` rows exist yet. Posts are synthesized + `state='completed'` later, in the Hermes completion callback — which is exactly where `autoScheduleApprovedPostsForJob` already runs (`hermes-callbacks.ts:1343`, inside `synthesizePublishPostsOnCompletion`). Hooking the orchestrator would run against zero posts and no-op.
- **Implementation:** add flag parser `autoScheduleOnApprovalEnabled()`; change the `:1343` guard from `if (autoApproveMarketingPipelineEnabled())` to `if (autoApproveMarketingPipelineEnabled() || autoScheduleOnApprovalEnabled())`. One hook → correct for human-approve, auto-approve, multi-stage, AND reconciler-delivered completions; fires once per terminal callback; idempotent on re-delivery. DELETE the two-entry-point/orchestrator-hook idea (it would reintroduce double-fire).
- **No redundant scope guard:** the publish-stage + approved invariant is already structural (`:1343` runs only in the publish-completion branch; synthesize inserts posts as `'approved'`). Assert it in a test, not a WHERE clause.
- Idempotency: `upsertScheduledPost` ON CONFLICT(post_id) (re-schedule, not dup); double-PUBLISH guard is `scheduled_post_dispatches UNIQUE(scheduled_post_id, platform)` (init-db.js:713), owned by the dispatch worker.

**Piece B corrections:**
- **Worker home:** standalone single-replica `docker-compose.yml` service (like `aries-scheduled-posts-worker`), NOT start-runtime (which spawns siblings only under cluster primary). `restart: unless-stopped`, points at `http://aries-app:3000`.
- **Atomic claim (not read-then-write):** `UPDATE marketing_schedule SET last_triggered_at=now() WHERE tenant_id=$1 AND enabled AND <due-predicate> AND (last_triggered_at IS NULL OR last_triggered_at < $window_start) RETURNING tenant_id`. Only a claimed (returned) row is submitted. Correct under concurrent ticks AND multiple containers.
- **Schema:** `marketing_schedule(tenant_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE, cadence text, day_of_week int, hour int, timezone text, enabled bool, last_triggered_at timestamptz, last_attempt_at timestamptz, last_success_at timestamptz, created_at, updated_at)`. **MUST be added to `scripts/init-db.js`** (the runtime applies init-db.js on container start; `migrations/`-only files never run in prod — silent footgun). Add to migrations/ too for record.
- **Profile field:** the business profile has `website_url`, NOT `brand_url`. The active-tenant predicate keys on `website_url` present + onboarding complete + `enabled`. Call `startSocialContentJob`/`handlePostMarketingJobs` with the handler-shaped payload (via `enrichPayloadFromBusinessProfile`), not a bare `{brand_url}`.
- **Submit-failure = loud, no lost week:** on submit throw after claim, revert `last_triggered_at` (or use last_attempt/last_success split) + alert; next tick retries. Dedicated test.
- **Timezone:** reuse `wallTimeToUtc` / `tenantLocalDayIndex` / `DEFAULT_TENANT_TIMEZONE` (DST-safe). Compute the cadence window in tenant-local time.
- **Channel-gate guard:** a tenant stuck at `requires_channel_connection` (no Meta) never completes publish; don't re-trigger forever — alert/skip.

**Reaper companion:** confirmed reaper reaps `awaiting_approval`/`approval_required` (stale-run-reaper.ts:134/149, strategy threshold 5 min). Add `ARIES_REAPER_AWAITING_APPROVAL_THRESHOLD_MS` (~7d) applied only in approval-waiting states + loud log on reap. NOT un-reapable.

### Architecture (ASCII)

```
[weekly-trigger-worker]  (compose service, 1 replica, ARIES_WEEKLY_TRIGGER_ENABLED)
   every 15m: atomic-claim due rows in marketing_schedule (tenant-local tz)
      -> POST /api/marketing/jobs (startSocialContentJob, weekly_social_content)
            -> Hermes: research -> strategy -> production -> publish
                 (each stage pauses awaiting_approval; auto-approve OFF)
   operator approves in dashboard
      -> publish-stage approval -> Hermes completion callback
            -> hermes-callbacks.ts:1343  synthesizePublishPostsOnCompletion
                 if autoApprove OR autoScheduleOnApproval (NEW):
                    autoScheduleApprovedPostsForJob -> autoSchedulePosts
                       upsertScheduledPost(post x {IG,FB}, staggered)   [Piece A]
[scheduled-posts-worker] (exists): drains scheduled_posts -> /scheduled-dispatch -> IG + FB
[stale-run-reaper] (exists, companion change): awaiting_approval gets 7d threshold + alert
```

### Test diagram → coverage
See test plan artifact: ~/.gstack/projects/DeliciousHouse-aries-app/feat-weekly-automation-test-plan-*.md (Piece A unit+no-op+idempotency live-DB; Piece B atomic-claim+tz+submit-failure live-DB; reaper threshold; single-tenant E2E rendered-on-both-accounts).

### NOT in scope
Stories/Reels/video; tenant-facing scheduling UI beyond the minimal day/hour/tz control; changing ARIES_AUTO_APPROVE default.

---

## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|-------|----------|-------|-----------|-----------|
| 1 | CEO | Build both A+B (premise gate) | User decision | — | Operator chose original direction over "hold B"; risk-fixes folded in |
| 2 | Eng | Piece A = 1-line guard at hermes-callbacks.ts:1343, reject orchestrator hook | Mechanical | P5/P4 | Orchestrator hook runs against zero posts (no-op); :1343 is the real completion point |
| 3 | Eng | Single hook only (drop two-entry convergence) | Mechanical | P5 | Two hooks reintroduce double-fire; single hook is once-per-callback + idempotent |
| 4 | Eng | No redundant published_status WHERE filter | Mechanical | P5 | Guard is structural (publish branch + synthesize inserts 'approved'); assert in test |
| 5 | Eng | Atomic conditional-claim UPDATE for dedup | Mechanical | P5 | Read-then-write races under concurrent ticks / multi-container |
| 6 | Eng | Worker = standalone single-replica compose service | Mechanical | P4 | Matches existing worker pattern; start-runtime siblings only run under cluster primary |
| 7 | Eng | Schema in scripts/init-db.js (not migrations/ only) | Mechanical | — | Runtime applies init-db.js; migrations/-only never runs in prod (silent footgun) |
| 8 | Eng | website_url (not brand_url) in predicate | Mechanical | — | brand_url column does not exist |
| 9 | CEO+Eng | Reaper: 7d awaiting-approval threshold + alert, not un-reapable | Adopted | P1 | Preserves wedge-detection; matches operator premise-gate note |
