/**
 * Weekly-trigger core: start a `weekly_social_content` job for one tenant. The internal route
 * (app/api/internal/marketing/weekly-trigger) and any test drive this; the
 * worker (scripts/automations/weekly-job-trigger-worker.ts) only decides WHICH
 * tenants are due and POSTs to the route.
 *
 * The only deliberate skip is an incomplete profile: without a website/brand
 * URL the pipeline has nothing to research. Channel connection is a publish
 * concern, not a generation gate, and job startup plus the Hermes port own
 * brand-kit creation/refresh. Keeping either check here permanently stranded a
 * tenant after its seven-day brand-kit TTL and prevented disconnected tenants
 * from preparing content for review.
 *
 * A skip is reported with a reason so the worker can alert without treating the
 * claim as a lost week (the claim already prevents re-trigger until the next
 * cadence window).
 */
import { startSocialContentJob } from '@/backend/marketing/orchestrator';
import { findRecentJobIdForTenant } from '@/backend/marketing/runtime-state';
import { marketingPayloadDefaultsFromBusinessProfile } from '@/backend/tenant/business-profile';

// Stamped on every worker-started job so the idempotency lookup can scope to
// this worker's OWN runs (never a manual generation). Must match the value the
// worker would otherwise hardcode.
export const WEEKLY_TRIGGER_CREATED_BY = 'weekly-trigger-worker';

// Idempotency window for the lost-response guard. The worker reverts its atomic
// claim on a failed/lost trigger response and re-fires next tick; if the app had
// actually created the job, that would duplicate it. We treat a worker-created
// weekly job newer than this as "already triggered this window" and no-op. 6
// days is shorter than the (weekly) cadence, so a legitimate next-week run is
// never collapsed; it is far longer than the tick interval, so it reliably
// catches the re-fire.
const WEEKLY_DEDUP_WINDOW_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

export type WeeklyTriggerSkipReason = 'incomplete_profile';

export type WeeklyTriggerResult =
  | { status: 'started'; jobId: string; currentStage?: string; approvalRequired?: boolean; deduped?: boolean }
  | { status: 'needs_connection'; jobId: string }
  | { status: 'skipped'; reason: WeeklyTriggerSkipReason }
  | { status: 'error'; message: string };

export type WeeklyTriggerDeps = {
  loadPayloadDefaults?: typeof marketingPayloadDefaultsFromBusinessProfile;
  startJob?: typeof startSocialContentJob;
  findRecentJobId?: typeof findRecentJobIdForTenant;
  now?: () => number;
};


function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Run the profile gate and, if it passes, start a weekly_social_content job for the
 * tenant. Pure of HTTP — the route is a thin wrapper. Throws are surfaced as
 * `{ status: 'error' }` so the worker can revert its claim and retry next tick.
 */
export async function triggerWeeklyJobForTenant(
  tenantId: string,
  deps: WeeklyTriggerDeps = {},
): Promise<WeeklyTriggerResult> {
  const loadPayloadDefaults = deps.loadPayloadDefaults ?? marketingPayloadDefaultsFromBusinessProfile;
  const startJob = deps.startJob ?? startSocialContentJob;
  const findRecentJobId = deps.findRecentJobId ?? findRecentJobIdForTenant;
  const nowMs = (deps.now ?? Date.now)();

  try {
    // Profile completeness — need at least a brand/website URL + type. Job
    // startup creates a missing kit, and the Hermes port refreshes/enriches it
    // before submission; do not pre-empt those recovery paths here.
    const defaults = await loadPayloadDefaults(tenantId);
    const websiteUrl = asTrimmedString(defaults.websiteUrl);
    const businessType = asTrimmedString(defaults.businessType);
    if (!websiteUrl || !businessType) {
      return { status: 'skipped', reason: 'incomplete_profile' };
    }

    const payload: Record<string, unknown> = {
      brandUrl: websiteUrl,
      websiteUrl,
      businessType,
      // The scheduled weekly cadence exists to DELIVER posts, so the job must
      // take the real publish path (synthesize + auto-schedule at the terminal
      // callback), not the publish-SKIP path. Without this,
      // requestedPublishFlag(doc) reads false (the flag lives in
      // inputs.request), the weekly job's posts strand approved-unscheduled,
      // and the only content that ever published was the reel-companion job's
      // rogue feed posts — now clamped by synthesize-publish-posts.ts. The
      // human-facing create form intentionally still omits this flag (an
      // operator-created draft week stays review-first).
      publishRequested: true,
    };
    const carry = (key: string, value: string | string[] | undefined) => {
      if (typeof value === 'string' && value.trim().length > 0) payload[key] = value;
      else if (Array.isArray(value) && value.length > 0) payload[key] = value;
    };
    carry('businessName', defaults.businessName);
    carry('primaryGoal', defaults.primaryGoal);
    carry('goal', defaults.goal);
    carry('offer', defaults.offer);
    carry('competitorUrl', defaults.competitorUrl);
    carry('channels', defaults.channels);
    carry('brandVoice', defaults.brandVoice);
    carry('styleVibe', defaults.styleVibe);
    carry('launchApproverName', defaults.launchApproverName);
    carry('approverName', defaults.approverName);

    // Idempotency: if this worker already created a weekly job for the tenant
    // within the dedup window, a re-fire after a lost HTTP response would
    // duplicate it. Collapse onto the existing job instead of starting another.
    // Scoped to WEEKLY_TRIGGER_CREATED_BY so manual generations never block a
    // scheduled run, and bounded to < cadence so next week's run is never collapsed.
    const existingJobId = await findRecentJobId(tenantId, {
      jobType: 'weekly_social_content',
      createdBy: WEEKLY_TRIGGER_CREATED_BY,
      sinceEpochMs: nowMs - WEEKLY_DEDUP_WINDOW_MS,
    });
    if (existingJobId) {
      return { status: 'started', jobId: existingJobId, deduped: true };
    }

    const result = await startJob({
      tenantId,
      jobType: 'weekly_social_content',
      createdBy: WEEKLY_TRIGGER_CREATED_BY,
      payload,
    });

    if (result.status === 'needs_connection') {
      return { status: 'needs_connection', jobId: result.jobId };
    }
    return {
      status: 'started',
      jobId: result.jobId,
      currentStage: result.currentStage,
      approvalRequired: result.approvalRequired,
    };
  } catch (err) {
    return { status: 'error', message: (err as Error)?.message ?? String(err) };
  }
}
