import { loadQuotaSummary, type Queryable } from '@/backend/billing/quota-summary';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

/**
 * GET /api/billing/quota — the workspace's usage allowance for the settings-hub
 * "Usage & capacity" card (AA-164): included allowance, purchased credits,
 * consumption this period, and percentage consumed.
 *
 * Mirrors app/api/marketing/posting-times/handler.ts: tenant id resolved ONLY
 * from tenantContext (never body/query), queries strictly sequential,
 * frontend-safe payloads only.
 *
 * Readable by any authenticated tenant role — a viewer being able to see how
 * much capacity is left is not a privilege escalation, and hiding it makes the
 * "why did generation stop" question unanswerable for most of the team.
 * `canPurchase` gates only the buy affordance, and is admin-only per the AC.
 *
 * `purchaseEnabled` reports whether a payment gateway is actually configured.
 * It is false today because no gateway is connected yet, and the card renders a
 * contact-us line instead of a button that cannot complete. Surfacing this as
 * data (rather than hardcoding it in the UI) means the gateway PR flips one
 * server-side condition.
 */

type QuotaDeps = {
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

/**
 * True only when a payment gateway is wired end to end. Kept as one predicate so
 * the checkout PR has a single place to satisfy.
 */
export function isSelfServePurchaseEnabled(
  env: Partial<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean(env.BILLING_CHECKOUT_PROVIDER?.trim());
}

export async function handleGetBillingQuota(
  _req: Request,
  deps: QuotaDeps = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(deps.tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantContext } = tenantResult;
  const companyId = Number(tenantContext.tenantId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return json({ error: 'tenant_unresolved' }, 400);
  }

  const env = deps.env ?? process.env;
  try {
    const quota = await loadQuotaSummary(companyId, { db: deps.db, env, now: deps.now });
    return json(
      {
        quota,
        canPurchase: tenantContext.role === 'tenant_admin',
        purchaseEnabled: isSelfServePurchaseEnabled(env),
      },
      200,
    );
  } catch (error) {
    // Surface a failure rather than a zeroed summary: a wrong balance shown
    // confidently is worse than an error the customer can retry.
    console.error('[billing-quota] summary failed', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'quota_unavailable' }, 503);
  }
}
