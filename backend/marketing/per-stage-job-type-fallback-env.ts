/**
 * AA-235 rollout gate: infer the per-stage profile pipeline from the job doc's
 * TOP-LEVEL `job_type` when `inputs.request.jobType` is absent.
 *
 * WHY THIS EXISTS
 * `usesPerStageProfilePipeline()` (backend/marketing/ports/hermes.ts) decides
 * whether an `action:'run'` submission takes the weekly per-stage branch
 * (`buildSocialContentWeeklyRequest` — brand kit, scope, objective, prior-stage
 * artifacts) or the generic brand-campaign branch (a five-line prompt of bare
 * identifiers). It reads `doc.inputs.request.jobType`.
 *
 * Only ONE of the six job-creation sites stamps `jobType` INTO the payload that
 * becomes `inputs.request` (`app/api/marketing/jobs/handler.ts`). The other
 * five — `weekly-trigger.ts`, `onboarding-variant-batch.ts`,
 * `variant-pick-finalize.ts`, `app/onboarding/resume/page.tsx`, and (for its
 * outer arg) `weekly-reel-trigger.ts` — pass `jobType` as a SIBLING parameter
 * to `startSocialContentJob`, and `runtime-state.ts` stores `request:
 * input.payload` verbatim. So every scheduled weekly run reaches Hermes with no
 * brand kit, no scope, no prior-stage output — and the agent, correctly,
 * refuses for lack of inputs. On 2026-08-12 that refusal prose was synthesized
 * into `posts.caption`, auto-approved and published to live brand accounts.
 *
 * WHY IT IS GATED
 * Turning the fallback on switches those runs onto a DIFFERENT workflow key
 * (`social_content_weekly`), a different request builder, different per-stage
 * gateways, and the brand-kit refresh gate. That path is well exercised in
 * production by the one-off reel companion and by dashboard-created jobs, but
 * NOT by the weekly-trigger tenant population. The blast radius of getting it
 * wrong is every scheduled weekly run on the fleet, so the enabling decision
 * belongs to an operator, not to the code that ships the fix.
 *
 * The same gate gates the companion root-cause fix in `orchestrator.ts` that
 * stamps `requestPayload.jobType`, because a stamped request would otherwise
 * take the ungated `inputs.request.jobType` branch and flip every NEW weekly
 * job fleet-wide the moment this lands.
 *
 * VALUES (mirrors ARIES_PLATFORM_NATIVE_CONTENT_ENABLED)
 *   unset / falsy  → OFF (default; behaviour byte-identical to pre-AA-235)
 *   1|true|yes|on  → ON fleet-wide
 *   "70,71"        → ON for those tenant ids only (canary)
 *
 * Reading the doc's own `job_type` self-heals docs ALREADY persisted: the 69
 * weekly docs on disk with `inputs.request.jobType` absent all carry
 * `job_type: 'weekly_social_content'` at the top level, written by
 * `createSocialContentJobRuntimeDocument`.
 */
type Env = Partial<Record<string, string | undefined>>;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/** Normalize a tenant id (number | numeric string) to its decimal string, or null. */
function normalizeTenantIdToken(value: number | string | null | undefined): string | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

export function isPerStageJobTypeFallbackEnabled(
  env: Env = process.env,
  tenantId?: number | string | null,
): boolean {
  const raw = env.ARIES_PER_STAGE_JOB_TYPE_FALLBACK_ENABLED?.trim().toLowerCase() ?? '';
  if (!raw) return false;
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;

  // Tenant-ID allowlist. Compared as normalized decimal strings so '70', ' 70 '
  // and the numeric 70 all match the same entry.
  const wanted = normalizeTenantIdToken(tenantId);
  if (wanted === null) return false;
  return raw
    .split(',')
    .map((token) => normalizeTenantIdToken(token))
    .some((token) => token !== null && token === wanted);
}
