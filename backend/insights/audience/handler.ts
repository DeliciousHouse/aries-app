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
 *
 * FRESHNESS: 60s micro-cache. Demographics and active-time grids are synced
 * periodically and move over days; the upcoming-schedule list changes only when
 * a post is scheduled, which is not a read-path operation.
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

  // S7-3/AA-121: consult the cache BEFORE any pooled work — a hit must cost
  // no database client at all, which is the point of caching these.
  const cacheKey = insightsMicroCacheKey('audience', tenantId, { period, platform });
  const cached = readInsightsMicroCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  }

  const snapshot = await buildAudienceSnapshot(tenantId, period, platform);

  const body = {
    status: 'ok',
    period,
    platform,
    ...snapshot,
  };

  writeInsightsMicroCache(cacheKey, body, INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS);

  return NextResponse.json(body, {
    headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
  });
}
