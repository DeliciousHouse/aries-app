import {
  isUsageGranularity,
  loadUsageAnalytics,
  type Queryable,
  type UsageGranularity,
} from '@/backend/telemetry/usage-analytics';
import { isUsageAnalyticsEnabled } from '@/backend/telemetry/usage-analytics-env';
import { resolvePlanEnforcementMetric } from '@/backend/billing/plan-enforcement-env';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

/**
 * GET /api/telemetry/usage-analytics — this workspace's own consumption
 * breakdown for the `/dashboard/usage` page (AA-166): consumption over time at
 * a daily / weekly / monthly grain, top users, slowest tasks, and the AI vs.
 * local-automation split.
 *
 * Mirrors app/api/billing/quota/handler.ts: tenant id resolved ONLY from
 * tenantContext (never body/query), queries strictly sequential, frontend-safe
 * payloads only, and a failure is a 503 rather than a zeroed body.
 *
 * Admin-only, unlike /api/billing/quota. That route answers "how much capacity
 * does my workspace have left", which everyone on the team needs. This one
 * attributes consumption to named colleagues, which is personnel-adjacent — and
 * the AC is written for a Customer Admin.
 *
 * `enforcementMetric` is echoed so the page defaults to the same measure the
 * plan gate actually enforces on, rather than picking its own.
 */

type UsageAnalyticsDeps = {
  tenantContextLoader?: TenantContextLoader;
  db?: Queryable;
  env?: Partial<Record<string, string | undefined>>;
  now?: () => Date;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleGetUsageAnalytics(
  req: Request,
  deps: UsageAnalyticsDeps = {},
): Promise<Response> {
  const env = deps.env ?? process.env;

  // Flag check BEFORE anything else: a flag-off endpoint is invisible to every
  // role and touches no DB (the ARIES_IMAGE_EDIT_ENABLED / posting-times
  // precedent). A 403 here would reveal the surface exists.
  if (!isUsageAnalyticsEnabled(env)) {
    return json({ error: 'usage_analytics_disabled' }, 404);
  }

  const tenantResult = await loadTenantContextOrResponse(deps.tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantContext } = tenantResult;
  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  const companyId = Number(tenantContext.tenantId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return json({ error: 'tenant_unresolved' }, 400);
  }

  // An unrecognized grain is rejected rather than silently answered at the
  // default: a chart labelled "Monthly" showing daily buckets is worse than an
  // error the caller can fix.
  const requested = new URL(req.url).searchParams.get('granularity');
  if (requested !== null && !isUsageGranularity(requested)) {
    return json({ error: 'invalid_granularity' }, 400);
  }
  const granularity: UsageGranularity = requested ?? 'daily';

  try {
    const analytics = await loadUsageAnalytics(companyId, {
      granularity,
      db: deps.db,
      ...(deps.now ? { now: deps.now } : {}),
    });
    return json(
      {
        analytics,
        enforcementMetric: resolvePlanEnforcementMetric(env),
      },
      200,
    );
  } catch (error) {
    // Surface a failure rather than an empty breakdown: a confidently empty
    // usage report reads as "nobody used anything", which is a wrong answer.
    console.error('[usage-analytics] load failed', {
      companyId,
      granularity,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'usage_analytics_unavailable' }, 503);
  }
}
