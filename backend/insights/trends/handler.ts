/**
 * backend/insights/trends/handler.ts
 *
 * Handles GET /api/insights/trends requests.
 *
 * Returns Section 5 — Performance Trends:
 *   - metrics: headline/supporting/interpretation per metric tab
 *   - series:  current + prior time-series per metric (for the chart)
 *   - keyMovements: 3-5 notable movements for the right-side card
 *   - platformBreakdown: per-platform share per metric (for the bar)
 *   - visitsAvailable: whether the Visits tab should be shown
 *
 * Cache TTL: 1 hour. Trend data changes only when new sync runs complete.
 * ?force=true bypasses cache.
 */

import { NextResponse } from 'next/server';
import pool, { type PoolClient } from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { buildTrendsSnapshot } from './trends-snapshot-builder';
import { buildMetricDisplays, buildKeyMovements } from './trends-template-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';
import crypto from 'crypto';

// v2: builder output changed (fixed ::date bucketing so the current-period
// reach series populates); bump so a stale trends-v1 cache row showing reach=0
// is invalidated instead of served for up to the TTL.
// v4: S2-1 — the top-post title is now selected by latest lifetime reach per
// post (not SUM across dated cumulative rows), so the chosen title can change.
// (The headline trends numbers are account-level and unchanged.) Bump
// invalidates stale v3 bodies.
// v5: S3-1 (AA-97) honesty pass — the engagement + visit-to-follow interpretation
// copy no longer cites a fabricated "1–3.5% range for design accounts" benchmark
// or assumes a "design accounts" niche (the tenant is not a design account); the
// copy is now niche-neutral with no invented statistic. Bump invalidates v4.
const TEMPLATE_VERSION = 'trends-v5';
const CACHE_TTL_MS     = 60 * 60 * 1000; // 1 hour

const VALID_PERIODS = new Set<string>(['week', '30day', '90day']);

function isValidPeriod(p: string | null): p is NarrativePeriod {
  return p != null && VALID_PERIODS.has(p);
}

function inputHash(tenantId: number, period: string, platform: string): string {
  return crypto
    .createHash('sha256')
    .update(`${tenantId}|${period}|${platform}|${TEMPLATE_VERSION}`)
    .digest('hex')
    .slice(0, 16);
}

async function getCached(
  client:   PoolClient,
  tenantId: number,
  period:   string,
  platform: string,
): Promise<{ body: Record<string, unknown>; generatedAt: Date } | null> {
  const res = await client.query<{
    body:         Record<string, unknown>;
    generated_at: Date;
    model:        string;
  }>(
    `SELECT body, generated_at, model
     FROM insights_narratives
     WHERE tenant_id   = $1
       AND period      = $2
       AND platform    = $3
       AND section_key = 'trends'
     LIMIT 1`,
    [tenantId, period, platform],
  );
  if (res.rows.length === 0) return null;
  const row   = res.rows[0];
  const ageMs = Date.now() - new Date(row.generated_at).getTime();
  if (ageMs >= CACHE_TTL_MS || row.model !== TEMPLATE_VERSION) return null;
  return { body: row.body, generatedAt: row.generated_at };
}

async function upsert(
  client:   PoolClient,
  tenantId: number,
  period:   string,
  platform: string,
  body:     Record<string, unknown>,
  hash:     string,
): Promise<void> {
  await client.query(
    `INSERT INTO insights_narratives
       (tenant_id, period, platform, section_key, body, prompt_version, model, input_hash, cost_cents, generated_at)
     VALUES ($1, $2, $3, 'trends', $4, $5, $6, $7, 0, now())
     ON CONFLICT (tenant_id, period, platform, section_key)
     DO UPDATE SET
       body           = EXCLUDED.body,
       prompt_version = EXCLUDED.prompt_version,
       model          = EXCLUDED.model,
       input_hash     = EXCLUDED.input_hash,
       cost_cents     = 0,
       generated_at   = now()`,
    [tenantId, period, platform, JSON.stringify(body), TEMPLATE_VERSION, TEMPLATE_VERSION, hash],
  );
}

export async function handleGetInsightsTrends(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const { searchParams } = new URL(req.url);
  const periodParam   = searchParams.get('period');
  const platformParam = (searchParams.get('platform') || 'all').toLowerCase();
  const force         = searchParams.get('force') === 'true';

  if (!isValidPeriod(periodParam)) {
    return NextResponse.json(
      { error: 'Invalid period. Use: week | 30day | 90day' },
      { status: 400 },
    );
  }

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const period   = periodParam;
  const platform = platformParam;

  const client = await pool.connect();
  try {
    if (!force) {
      const cached = await getCached(client, tenantId, period, platform);
      if (cached) {
        return NextResponse.json({
          status:       'ok',
          platform,
          period,
          cached:       true,
          generated_at: cached.generatedAt,
          ...cached.body,
        });
      }
    }

    const snap     = await buildTrendsSnapshot(tenantId, period, platform);
    const displays = buildMetricDisplays(snap, period, platform);
    const moves    = buildKeyMovements(snap, period, platform);
    const hash     = inputHash(tenantId, period, platform);

    const body: Record<string, unknown> = {
      metrics:           displays,
      series:            snap.series,
      keyMovements:      moves,
      platformBreakdown: snap.platformBreakdown,
      visitsAvailable:   snap.visitsAvailable,
      meta: {
        postCount:  snap.postCount,
        unreplied:  snap.unreplied,
        hasData:    snap.reach.value > 0 || snap.followers.value > 0,
      },
    };

    await upsert(client, tenantId, period, platform, body, hash);

    return NextResponse.json({
      status:       'ok',
      platform,
      period,
      cached:       false,
      generated_at: new Date(),
      ...body,
    });
  } finally {
    client.release();
  }
}
