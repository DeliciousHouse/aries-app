/**
 * backend/insights/conversations/handler.ts
 *
 * Handles GET /api/insights/conversations requests.
 *
 * No caching — comment data is real-time; staleness is immediately visible
 * to the user (unread counts, reply status).
 * ?force=true bypasses the micro-cache and rebuilds.
 *
 * FRESHNESS: 60s micro-cache, the shortest window the card allows, because
 * this payload carries reply/unread state. The cache is INVALIDATED for the
 * tenant when a reply succeeds (see the native-reply route), so an operator
 * never watches their own reply fail to appear. Everything else here — new
 * inbound comments — may lag by up to 60s, which is the trade the card asks
 * for.
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
  // S7-3/AA-121: the UI's Retry button sends ?force=true. Before this section
  // was cached that was a no-op; now it MUST bypass the cache, or Retry
  // returns the same body for up to 60s and looks broken.
  const force = searchParams.get('force') === 'true';
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
  const cacheKey = insightsMicroCacheKey('conversations', tenantId, { period, platform });
  const cached = force ? null : readInsightsMicroCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  }

  const snapshot = await buildConversationsSnapshot(tenantId, period, platform);

  const body = {
    status:   'ok',
    period,
    platform,
    ...snapshot,
  };

  writeInsightsMicroCache(cacheKey, body, INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS);

  return NextResponse.json(body, {
    headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
  });
}
