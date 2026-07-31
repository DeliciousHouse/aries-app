import {
  loadUsageAttribution,
  parseUsageAttributionFilters,
  type Queryable,
} from '@/backend/telemetry/usage-attribution';
import { isInternalUsageDashboardEnabled } from '@/backend/telemetry/usage-attribution-env';
import { resolveInternalOpsActor, type SessionLoader } from '@/lib/internal-ops-access';

/**
 * GET /api/internal/usage-attribution — cross-company usage & cost attribution
 * for internal ops/finance (AA-165). Filterable by company, date range, user and
 * task type; returns the engine ratio and per-client margin.
 *
 * This is the ONE route in the app that deliberately reads across tenants, so
 * its authorization is deliberately NOT tenant context:
 *
 *   - `tenantContext.role === 'tenant_admin'` means the CUSTOMER's admin. Every
 *     other `app/api/internal/admin/*` route uses it because those routes act on
 *     that customer's own data. Reusing it here would hand every customer admin
 *     every other customer's usage.
 *   - Access is a staff email allow-list checked against the session
 *     (lib/internal-ops-access.ts), which nothing inside the product can grant.
 *   - The flag is checked FIRST, so when the surface is off it is a real 404 for
 *     everyone, staff included, and no session lookup or DB read happens.
 *
 * Failure discipline is the inverse of the usage guards: those fail OPEN because
 * a metering outage must not look like a paywall. This fails CLOSED, because a
 * session-store outage must not look like a staff badge.
 */

type UsageAttributionDeps = {
  sessionLoader?: SessionLoader;
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

export async function handleGetUsageAttribution(
  req: Request,
  deps: UsageAttributionDeps = {},
): Promise<Response> {
  const env = deps.env ?? process.env;

  if (!isInternalUsageDashboardEnabled(env)) {
    return json({ error: 'internal_usage_dashboard_disabled' }, 404);
  }

  const access = await resolveInternalOpsActor(deps.sessionLoader, env);
  if (!access.ok) {
    return json({ error: access.reason }, access.status);
  }

  const url = new URL(req.url);
  const parsed = parseUsageAttributionFilters(
    url.searchParams,
    (deps.now ?? (() => new Date()))(),
  );
  if (!parsed.ok) {
    // Reject rather than silently ignore: a finance figure that quietly answered
    // a different question than the filters on screen is the worst outcome here.
    return json({ error: parsed.error }, 400);
  }

  try {
    const attribution = await loadUsageAttribution(parsed.filters, { db: deps.db });
    return json({ attribution }, 200);
  } catch (error) {
    console.error('[usage-attribution] load failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'usage_attribution_unavailable' }, 503);
  }
}
