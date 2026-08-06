import { NextResponse } from 'next/server';

import { buildWeeklyResultsReport } from '@/backend/marketing/weekly-results-report';
import { isWeeklyResultsEnabled } from '@/backend/marketing/weekly-results-env';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

/**
 * S5-1 / AA-110 — GET /api/dashboard/weekly-results
 *
 * Returns the weekly results report for the signed-in tenant's most-recent
 * completed ISO week, or the `?week=YYYY-WW` override.
 *
 * Flag OFF ⇒ `{ enabled: false }` and NO database work at all. The gate runs
 * before the tenant lookup and before any pooled client is taken, so a disabled
 * deployment pays nothing for this route.
 *
 * Read-only: this endpoint builds a report and writes nothing.
 */
export async function handleGetWeeklyResults(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
): Promise<Response> {
  if (!isWeeklyResultsEnabled()) {
    return NextResponse.json({ enabled: false }, { status: 200 });
  }

  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }

  // Tenant comes ONLY from the resolved context — never from the request.
  const tenantId = Number(tenantResult.tenantContext.tenantId);
  if (!Number.isSafeInteger(tenantId) || tenantId < 1) {
    return NextResponse.json(
      { status: 'error', reason: 'tenant_context_required' },
      { status: 403 },
    );
  }

  const weekIso = new URL(req.url).searchParams.get('week');

  try {
    const report = await buildWeeklyResultsReport(tenantId, { weekIso });
    return NextResponse.json({ enabled: true, report }, { status: 200 });
  } catch (error) {
    console.error('[weekly-results] report build failed', error);
    // Frontend-safe only: never leak the raw error / SQL / file paths.
    return NextResponse.json(
      { status: 'error', reason: 'weekly_results_unavailable' },
      { status: 503 },
    );
  }
}

export async function GET(req: Request) {
  return handleGetWeeklyResults(req);
}
