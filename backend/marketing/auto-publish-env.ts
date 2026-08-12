/**
 * Fleet-wide kill switch for the owner-gated auto-publish gate.
 *
 * Background: auto-schedule and auto-publish were the same action. Scheduling a
 * post wrote a `scheduled_posts` row with `dispatch_status='pending'`, and
 * `scheduled-posts-worker` claimed it at `scheduled_for` and pushed it straight
 * to the provider. The manual path (`app/api/publish/dispatch`) has always
 * consumed a `marketing_approval_record` first; the scheduled path had no
 * equivalent human gate, so every tenant on the autonomous flags published
 * without review.
 *
 * When ON: a due row is dispatched only if its tenant has opted in via
 * `marketing_auto_publish_settings` (see `backend/marketing/auto-publish-store.ts`,
 * written by tenant_admin through `app/api/marketing/auto-publish`). A tenant
 * that has not opted in is HELD — the post stays on the calendar past its slot
 * with a manual Publish control, and is excluded from the dead-campaign sweep so
 * the week never silently expires. Auto-scheduling itself is unaffected: the
 * calendar populates for everyone either way.
 *
 * When OFF (default): the gate is inert. Claim, due-scan and sweep behave
 * exactly as before and `marketing_auto_publish_settings` is never probed (the
 * `$n = false` arm short-circuits ahead of the EXISTS) — pinned against a real
 * planner by the "gate OFF" cases in
 * tests/marketing/auto-publish-gate-live-db.test.ts.
 *
 * IMPORTANT — this flag must be set on BOTH the `aries-app` service and the
 * `aries-scheduled-posts-worker` service. The admit predicate runs inside the
 * worker's SQL, unlike ARIES_AUTO_APPROVE_MARKETING_PIPELINE which is
 * aries-app-only. The worker parses it independently (plain `.mjs`, it cannot
 * import this module); keep the two token lists in sync.
 *
 * Treat 1/true/yes/on as enabled, matching the
 * ARIES_SYNTHESIZE_ON_PUBLISH_SKIP_ENABLED convention. Process-wide; default OFF.
 */
type Env = Partial<Record<string, string | undefined>>;

export function isAutoPublishGateEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_AUTO_PUBLISH_GATE_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
