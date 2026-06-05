/**
 * backend/insights/conversations/handler.ts
 *
 * Handles GET /api/insights/conversations requests.
 *
 * No caching — comment data is real-time; staleness is immediately visible
 * to the user (unread counts, reply status).
 * ?force=true accepted but has no effect (kept for API consistency).
 */

import { NextResponse } from 'next/server';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { buildConversationsSnapshot } from './conversations-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

const VALID_PERIODS = new Set<string>(['week', '30day', '90day']);

function isValidPeriod(p: string | null): p is NarrativePeriod {
  return p != null && VALID_PERIODS.has(p);
}

export async function handleGetInsightsConversations(
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

  const snapshot = await buildConversationsSnapshot(tenantId, period, platform);

  return NextResponse.json({
    status:   'ok',
    period,
    platform,
    ...snapshot,
  });
}
