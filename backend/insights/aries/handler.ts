/**
 * backend/insights/aries/handler.ts
 *
 * Handles GET /api/insights/aries requests.
 *
 * Section 8 — Working with Aries. Returns three components:
 *   approvalFlow  — first-try vs edited vs rebuilt counts from campaign_learning_labels
 *   learnings     — brand learnings (empty until Honcho / taste-signal pipeline is wired)
 *   learningCurve — weekly avg-attempts-to-approval trend
 *
 * No caching — approval outcomes are operator-facing; staleness shows immediately.
 */

import { NextResponse } from 'next/server';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { buildWorkingWithAriesSnapshot } from './aries-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

const VALID_PERIODS = new Set<string>(['week', '30day', '90day']);

function isValidPeriod(p: string | null): p is NarrativePeriod {
  return p != null && VALID_PERIODS.has(p);
}

export async function handleGetInsightsAries(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const { searchParams } = new URL(req.url);
  const periodParam = searchParams.get('period');

  if (!isValidPeriod(periodParam)) {
    return NextResponse.json(
      { error: 'Invalid period. Use: week | 30day | 90day' },
      { status: 400 },
    );
  }

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const period   = periodParam;

  const snapshot = await buildWorkingWithAriesSnapshot(tenantId, period);

  return NextResponse.json({
    status: 'ok',
    period,
    ...snapshot,
  });
}
