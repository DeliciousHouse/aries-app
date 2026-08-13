/**
 * backend/insights/weekly-recap/handler.ts
 *
 * Handles GET /api/insights/weekly-recap requests.
 *
 * Section 10 — Weekly Recap. AA-229/PR2b: the weekly-results report
 * (S5-1/AA-110, gap F1b) relocated out of backend/marketing/ and the old
 * `/dashboard/results` panel's dedicated route into the insights section
 * family, because tests/insights-route-auth-tenant-isolation.test.ts only
 * scans a handler's tenant-scoped SQL under backend/insights/**.
 *
 * Recaps the tenant's most-recent COMPLETED ISO week (Mon–Sun UTC), or the
 * `?week=YYYY-WW` override: published/skipped/blocked/needs-reconciliation
 * counts, the #519 reconnect signal, the top channel, and the derived
 * publish-reliability learnings + next action. `?period` / `?platform` are
 * deliberately ignored — this section has its own time axis (a week), not the
 * shared week|30day|90day one. Read-only: builds a report and writes nothing.
 *
 * Gate: ARIES_WEEKLY_RESULTS_ENABLED. OFF ⇒ `{ enabled: false }` returned
 * BEFORE tenant resolution and before any pooled client — the disabled
 * contract carried over verbatim from the pre-move panel
 * (tests/insights-weekly-recap-route.test.ts pins the ordering by string
 * offset; do not switch this to 404).
 *
 * FRESHNESS: 60s micro-cache, NOT an insights_narratives row. Two load-bearing
 * reasons: (a) the inputs (dispatch_status, oauth_connections.status) drive an
 * actionable "Reconnect Meta" CTA that a 1h TTL would leave stale — exactly
 * the case ../micro-cache.ts documents; (b) insights_narratives.period is
 * documented as week|30day|90day (scripts/init-db.js), and an ISO week would
 * either abuse that column or force `section_key='weekly-recap:<iso>'`,
 * growing one permanent ungarbaged row per tenant per week. The cache key is
 * built from the RESOLVED iso week, not the raw `?week=` string, so
 * `?week=2026-31`, `?week=2026-W31`, and no override at all (once they land
 * on the same week) share one entry.
 *
 * Guardrail #1: this handler owns the ONE pool.connect()/release() pair and
 * hands the client to the builder via its required `db` param — no
 * `Promise.all`, no second connection.
 */

import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import {
  INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS,
  insightsMicroCacheKey,
  microCacheControlHeader,
  readInsightsMicroCache,
  writeInsightsMicroCache,
} from '../micro-cache';
import { checkInsightsForceThrottle } from '../force-throttle';
import { isWeeklyResultsEnabled } from './weekly-recap-env';
import { resolveReportWeek } from './weekly-recap-week';
import { buildWeeklyResultsReport } from './weekly-recap-builder';

export async function handleGetInsightsWeeklyRecap(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
): Promise<Response> {
  // Precedes tenant resolution and any pooled client — a disabled deployment
  // pays nothing for this route.
  if (!isWeeklyResultsEnabled()) {
    return NextResponse.json({ enabled: false }, { status: 200 });
  }

  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  // Tenant comes ONLY from the resolved context — never from the request.
  const tenantId = Number(tenantResult.tenantContext.tenantId);
  if (!Number.isSafeInteger(tenantId) || tenantId < 1) {
    return NextResponse.json(
      { status: 'error', reason: 'tenant_context_required' },
      { status: 403 },
    );
  }

  const { searchParams } = new URL(req.url);
  const force = searchParams.get('force') === 'true';
  const now = new Date();
  // `?period` / `?platform` are deliberately ignored by this section — only
  // `?week` selects the window.
  const week = resolveReportWeek(searchParams.get('week'), now);

  // S7-3/AA-121: consult the cache BEFORE any pooled work — a hit must cost
  // no database client at all, which is the point of caching these.
  const cacheKey = insightsMicroCacheKey('weekly-recap', tenantId, { week: week.iso });
  const cached = force ? null : readInsightsMicroCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  }

  // AA-120: a forced request skipped the cache above and is about to rebuild on a
  // pooled client. Unthrottled, that is the authenticated DB-hammer path AA-120
  // closed for the other cached sections. Must run BEFORE pool.connect(): the
  // limiter's whole job is to keep a burst off the pool.
  const throttled = checkInsightsForceThrottle(force, tenantId, 'weekly-recap');
  if (throttled) return throttled;

  const client = await pool.connect();
  try {
    const report = await buildWeeklyResultsReport(tenantId, { weekIso: week.iso, now }, client);
    const body = { enabled: true, report };

    writeInsightsMicroCache(cacheKey, body, INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS);

    return NextResponse.json(body, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  } catch (error) {
    console.error('[weekly-recap] report build failed', error);
    // Frontend-safe only: never leak the raw error / SQL / file paths.
    return NextResponse.json(
      { status: 'error', reason: 'weekly_results_unavailable' },
      { status: 503 },
    );
  } finally {
    client.release();
  }
}
