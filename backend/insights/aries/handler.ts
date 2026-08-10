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
 *
 * FRESHNESS: 60s micro-cache. This section counts approval-flow outcomes and
 * a learning curve over weeks; a minute of lag is invisible at that grain.
 */

import { NextResponse } from 'next/server';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import {
  INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS,
  insightsMicroCacheKey,
  microCacheControlHeader,
  readInsightsMicroCache,
  writeInsightsMicroCache,
} from '../micro-cache';
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
  // S7-3/AA-121: the UI's Retry button sends ?force=true. Before this section
  // was cached that was a no-op; now it MUST bypass the cache, or Retry
  // returns the same body for up to 60s and looks broken.
  const force = searchParams.get('force') === 'true';
  const periodParam = searchParams.get('period');

  if (!isValidPeriod(periodParam)) {
    return NextResponse.json(
      { error: 'Invalid period. Use: week | 30day | 90day' },
      { status: 400 },
    );
  }

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const period   = periodParam;

  // S7-3/AA-121: consult the cache BEFORE any pooled work — a hit must cost
  // no database client at all, which is the point of caching these.
  const cacheKey = insightsMicroCacheKey('aries', tenantId, { period });
  const cached = force ? null : readInsightsMicroCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  }

  const snapshot = await buildWorkingWithAriesSnapshot(tenantId, period);

  const body = {
    status: 'ok',
    period,
    ...snapshot,
  };

  writeInsightsMicroCache(cacheKey, body, INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS);

  return NextResponse.json(body, {
    headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
  });
}
