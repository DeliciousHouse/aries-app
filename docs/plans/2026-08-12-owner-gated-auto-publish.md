# Owner-gated auto-publish

Status: implemented, shipped dark (2026-08-12)
Tracking: AA-223 · theme parent AA-70 (Multi-Tenant Team Roles & Governance Approval Policies)

## Problem

Auto-schedule and auto-publish were the same action.

`ARIES_AUTOSCHEDULE_ON_APPROVAL=1` writes a `scheduled_posts` row on publish-stage completion;
`dispatch_status` defaults to `'pending'`; `aries-scheduled-posts-worker` claims pending rows whose
`scheduled_for <= now()` and POSTs `/api/internal/publishing/scheduled-dispatch`, which calls
`dispatchPublish` straight into the Meta Graph API. No human step existed between "on the calendar"
and "live".

The manual path was already gated — `app/api/publish/dispatch/handler.ts` consumes a
`marketing_approval_record` before any Graph side-effect. The scheduled path had no equivalent, so
every tenant running the autonomous flags published without review, with no way to keep AI-generated
scheduling while holding the final publish for a human.

## Goal

| Behaviour | Before | After |
| --- | --- | --- |
| Auto-approve (`ARIES_AUTO_APPROVE_MARKETING_PIPELINE`) | fleet-wide ON | unchanged, fleet-wide ON |
| Auto-schedule (`ARIES_AUTOSCHEDULE_ON_APPROVAL`) | ON | unchanged, ON for everyone |
| Auto-publish | implied by auto-schedule | per-tenant opt-in, `tenant_admin` only |

## Decisions

1. **Held posts keep their calendar slot** and publish on click. They are excluded from the
   dead-campaign sweep, so a week is never silently expired for want of an owner click.
2. **Two controls.** `ARIES_AUTO_PUBLISH_GATE_ENABLED` (fleet-wide, default OFF, ships dark) plus the
   per-tenant row. Both must say yes.
3. **`tenant_admin` is the owner.** There is no owner role and `organizations` has no owner column;
   `tenant_admin` is the equivalent, and `backend/tenant/user-profiles.ts` guarantees every org keeps
   at least one active one.

## Design

The gate lives at **dispatch**, not at schedule time — one choke point, and flipping the toggle takes
effect immediately on rows already sitting on the calendar.

### Data model

`migrations/20260812000000_marketing_auto_publish_settings.sql`, mirrored into `scripts/init-db.js`:

```sql
CREATE TABLE IF NOT EXISTS marketing_auto_publish_settings (
  tenant_id          INTEGER PRIMARY KEY,
  enabled            BOOLEAN NOT NULL DEFAULT false,
  updated_by_user_id INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**No new column on `scheduled_posts` and no new `dispatch_status` value.** "Held" is derived from the
join, not stored. `dispatch_status` carries a 6-value CHECK constraint across two tables, and the
worker's own comments flag widening that union as the trap this repo has shipped three times. The
derived form also means a toggle flip releases held rows immediately instead of only affecting rows
scheduled afterwards.

**Absence == disabled.** The predicate is `EXISTS (… AND enabled)`, so an unseeded tenant is held
rather than published — the safe direction for a table that may not be backfilled yet, and the reason
step 2 of the rollout is not optional.

### Enforcement

`autoPublishAdmitSql(alias, param)` in `scripts/automations/scheduled-posts-worker.mjs` emits the
predicate once and splices it into all three dispatch-deciding statements:

- `DUE_ROWS_SQL` — held rows never enter the batch.
- `CLAIM_ROW_SQL` — held rows are not claimable even when addressed directly.
- `SWEEP_DEAD_CAMPAIGN_SQL` — all three arms (`canonical`, `dead`, `marked`), matching the file's
  "every mutating arm re-checks the full predicate" rule.

Two details carry the correctness:

- **The outer `tenant_id` must be alias-qualified.** An unqualified one resolves to the subquery's own
  `s.tenant_id` (inner scope wins), making the comparison `s.tenant_id = s.tenant_id` — always true,
  gate silently open, no error raised. Pinned by a test.
- **`$n = false` short-circuits before the `EXISTS`**, so with the gate off the settings table is
  never probed and the plan is unchanged.

`SWEEP_AMBIGUOUS_DISPATCH_SQL` is deliberately NOT gated: those rows already reached the provider, and
finalizing them from durable evidence has nothing to do with permission to publish.

### Release path

Releasing a held post is the existing manual publish (`/api/publish/dispatch`), which already consumes
a `marketing_approval_record`. No new publish path, no second way into Graph.

### API

`GET/PATCH /api/marketing/auto-publish`. PATCH is `tenant_admin` only, the same one-line guard
`app/api/marketing/schedule` and `app/api/business/profile` use. GET is readable by every tenant role —
an analyst seeing "auto-publish is off, posts wait for an admin" is what prevents a "nothing published"
bug report — and returns `gateActive` so the UI cannot present a dormant switch as live.

PATCH requires an explicit boolean; `{}` is rejected rather than treated as "leave it alone", because a
partial-update idiom on a single-field safety toggle reads as success while changing nothing.

## Tests

- `tests/marketing/auto-publish-gate.test.ts` (self-contained, 15 cases) — flag parsing incl. the
  worker/TS twin agreeing, store absence-means-disabled + upsert-not-update, route role guard and
  validation, tenant id from context only, and the predicate's shape in all three statements.
- `tests/marketing/auto-publish-gate-live-db.test.ts` (requires-infra, 5 cases) — real planner:
  gate off dispatches and sweeps everything; gate on admits only the opted-in tenant; **a held row past
  `campaign_end_date` survives the sweep with `dispatch_status='pending'` and its post still
  `approved`**. Builds its own schema, so it needs Postgres but not the app's migrations.

## Rollout

1. Merge dark (`ARIES_AUTO_PUBLISH_GATE_ENABLED` unset). Live behaviour unchanged.
2. **Seed `marketing_auto_publish_settings` with `enabled = true` for every tenant that should stay
   autonomous — before flipping the switch.** Enabling the gate makes held the default for all ~32
   orgs; any tenant not seeded stops publishing until an admin opts in. This is the step that turns a
   rollout into an incident if skipped.
3. Set `ARIES_AUTO_PUBLISH_GATE_ENABLED=1` on **both** `aries-app` and `aries-scheduled-posts-worker`.
   The predicate runs in the worker's SQL; the app copy only reports `gateActive` to the UI.
4. Watch for rows sitting past their slot with `dispatch_status='pending'`.

## Not built here

- **Held-tray UI + Publish control.** The API and the gate are done; the surfacing is not. Without it
  a held backlog is invisible — the same failure mode that produced 12 stranded rows in prod on
  2026-07-21. This should land before step 3.
- **Held-row housekeeping.** By decision 1 a held row past `campaign_end_date` lingers rather than
  self-clearing. Acceptable while the tray makes it visible; revisit if backlogs grow.
