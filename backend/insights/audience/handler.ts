/**
 * backend/insights/audience/handler.ts
 *
 * Handles GET /api/insights/audience requests.
 *
 * Section 9 — Audience. Returns three components:
 *   schedule     — upcoming pending scheduled posts (real data)
 *   demographics — age + location breakdown (hasData: false until Phase 3 adapters)
 *   activeTimes  — 7×24 heatmap grid          (hasData: false until Phase 3 adapters)
 *
 * No caching — schedule data is operator-facing and changes as posts are added.
 */

import { NextResponse } from 'next/server';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { buildAudienceSnapshot } from './audience-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

const VALID_PERIODS = new Set<string>(['week', '30day', '90day']);

function isValidPeriod(p: string | null): p is NarrativePeriod {
  return p != null && VALID_PERIODS.has(p);
}

export async function handleGetInsightsAudience(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const { searchParams } = new URL(req.url);
  const periodParam   = searchParams.get('period');
  const platformParam = (searchParams.get('platform') || 'all').toLowerCase();

  if (!isValidPeriod(periodParam)) {
    return NextResponse.json(
      { error: 'Invalid period. Use: week | 30day | 90day' },
      { status: 400 },
    );
  }

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const period   = periodParam;
  const platform = platformParam;

  const snapshot = await buildAudienceSnapshot(tenantId, period, platform);

  return NextResponse.json({
    status: 'ok',
    period,
    platform,
    ...snapshot,
  });
}
