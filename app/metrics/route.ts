import { collectAriesMetrics } from '@/backend/observability/prometheus-metrics';
import { probeHermesGatewayHealth } from '@/backend/marketing/hermes-runtime-contract';
import { resolveFleetTenantKinds } from '@/backend/tenant/organization-kind';
import pool from '@/lib/db';
import { verifyInternalCallbackRequest } from '@/lib/internal-callback-auth';

export const dynamic = 'force-dynamic';

function draftExpiryAgeDays(): number {
  const value = Number.parseInt(process.env.ARIES_DRAFT_EXPIRY_AGE_DAYS ?? '14', 10);
  return Number.isFinite(value) && value > 0 ? value : 14;
}

export async function GET(request: Request): Promise<Response> {
  const auth = verifyInternalCallbackRequest(request);
  if (!auth.ok) {
    return Response.json({ error: auth.reason }, { status: auth.status });
  }

  try {
    const hermes = await probeHermesGatewayHealth();
    const body = await collectAriesMetrics(pool, {
      hermesUp: hermes.ok,
      draftExpiryAgeDays: draftExpiryAgeDays(),
      tenantKinds: resolveFleetTenantKinds(),
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[metrics] scrape failed', error);
    return new Response('metrics unavailable\n', { status: 503 });
  }
}
