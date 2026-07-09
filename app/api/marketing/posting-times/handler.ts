import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import {
  deriveAndPersistPostingTimes,
  listPostingTimesForTenant,
  type DerivePostingTimesInput,
  type DerivePostingTimesResult,
  type PostingTimeQueryable,
} from '@/backend/marketing/posting-time-advisor';
import { isAiPostingTimesEnabled } from '@/backend/marketing/posting-times-env';

/**
 * GET  /api/marketing/posting-times        — the derived per-platform posting
 *   times for the settings card (any authenticated tenant role, read-only).
 * POST /api/marketing/posting-times/derive — force a fresh derivation
 *   (tenant_admin only). Fire-and-forget: the competitor research run can take
 *   a minute, so the route returns 202 immediately and the card refetches.
 *
 * Mirrors app/api/marketing/schedule/handler.ts: tenant id resolved ONLY from
 * tenantContext (never body/query), queries strictly sequential, frontend-safe
 * payloads only.
 */

type PostingTimesDeps = {
  tenantContextLoader?: TenantContextLoader;
  db?: PostingTimeQueryable;
  /** Injectable derivation for tests (defaults to the real advisor). */
  derive?: (input: DerivePostingTimesInput) => Promise<DerivePostingTimesResult>;
  env?: Partial<Record<string, string | undefined>>;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleGetPostingTimes(
  _req: Request,
  deps: PostingTimesDeps = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(deps.tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const enabled = isAiPostingTimesEnabled(deps.env ?? process.env);

  // When the feature is off there is nothing to show and nothing to read —
  // the card renders its "not enabled" copy off `enabled` alone.
  const postingTimes = enabled ? await listPostingTimesForTenant(tenantId, deps.db) : [];
  return json({ enabled, postingTimes }, 200);
}

export async function handleDerivePostingTimes(
  _req: Request,
  deps: PostingTimesDeps = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(deps.tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantContext } = tenantResult;

  // Flag check BEFORE the role check: a flag-off endpoint is invisible to
  // every role (the ARIES_NATIVE_REPLY_ENABLED / ARIES_IMAGE_EDIT_ENABLED
  // precedent) — a 403 for analysts would reveal it exists. 409 is reserved
  // for the shared workspace-mismatch interlock in requestJson.
  if (!isAiPostingTimesEnabled(deps.env ?? process.env)) {
    return json({ error: 'posting_times_disabled' }, 404);
  }
  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  // Tenant id ONLY from tenantContext — never from the body.
  const tenantId = Number(tenantContext.tenantId);
  const derive = deps.derive ?? deriveAndPersistPostingTimes;

  // Fire-and-forget with force (the button always re-derives past the TTL
  // guard). Errors are already contained inside the advisor; the extra catch
  // is belt-and-braces so the voided promise can never reject unhandled.
  void derive({
    tenantId,
    force: true,
    ...(deps.db ? { queryable: deps.db } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  }).catch(() => {});

  return json({ status: 'accepted' }, 202);
}
