/**
 * backend/insights/top/handler.ts
 *
 * Handles GET /api/insights/top requests.
 *
 * Returns Section 6 — Top Performing Content:
 *   - posts: top 5 Aries-generated posts, enriched with whyItWorked
 *   - pattern: the Pattern Spotted card (dominant content type across top 5)
 *   - sortBy: the active sort key (echoed back for the frontend dropdown)
 *
 * Cache TTL: 1 hour. Sort key changes produce a different cache entry,
 * so switching sort dropdown fires a fresh query if the period cache is cold,
 * but replays instantly while warm.
 * ?force=true bypasses cache.
 */

import { NextResponse } from 'next/server';
import pool, { type PoolClient } from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { buildTopSnapshot, isValidSort, type TopSortKey } from './top-snapshot-builder';
import { enrichPosts, buildPatternCard } from './top-template-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';
import crypto from 'crypto';

const TEMPLATE_VERSION = 'top-v1';
const CACHE_TTL_MS     = 60 * 60 * 1000;

const VALID_PERIODS = new Set<string>(['week', '30day', '90day']);

function isValidPeriod(p: string | null): p is NarrativePeriod {
  return p != null && VALID_PERIODS.has(p);
}

function inputHash(tenantId: number, period: string, platform: string, sortBy: string): string {
  return crypto
    .createHash('sha256')
    .update(`${tenantId}|${period}|${platform}|${sortBy}|${TEMPLATE_VERSION}`)
    .digest('hex')
    .slice(0, 16);
}

// Section key is scoped by sort so each sort order has its own cache row.
function sectionKey(sortBy: string): string {
  return `top:${sortBy}`;
}

async function getCached(
  client:   PoolClient,
  tenantId: number,
  period:   string,
  platform: string,
  sortBy:   string,
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
       AND section_key = $4
     LIMIT 1`,
    [tenantId, period, platform, sectionKey(sortBy)],
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
  sortBy:   string,
  body:     Record<string, unknown>,
  hash:     string,
): Promise<void> {
  await client.query(
    `INSERT INTO insights_narratives
       (tenant_id, period, platform, section_key, body, prompt_version, model, input_hash, cost_cents, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, now())
     ON CONFLICT (tenant_id, period, platform, section_key)
     DO UPDATE SET
       body           = EXCLUDED.body,
       prompt_version = EXCLUDED.prompt_version,
       model          = EXCLUDED.model,
       input_hash     = EXCLUDED.input_hash,
       cost_cents     = 0,
       generated_at   = now()`,
    [tenantId, period, platform, sectionKey(sortBy), JSON.stringify(body), TEMPLATE_VERSION, TEMPLATE_VERSION, hash],
  );
}

export async function handleGetInsightsTop(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const { searchParams } = new URL(req.url);
  const periodParam   = searchParams.get('period');
  const platformParam = (searchParams.get('platform') || 'all').toLowerCase();
  const sortParam     = searchParams.get('sort') ?? 'reach';
  const force         = searchParams.get('force') === 'true';

  if (!isValidPeriod(periodParam)) {
    return NextResponse.json(
      { error: 'Invalid period. Use: week | 30day | 90day' },
      { status: 400 },
    );
  }

  const sortBy: TopSortKey = isValidSort(sortParam) ? sortParam : 'reach';

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const period   = periodParam;
  const platform = platformParam;

  const client = await pool.connect();
  try {
    if (!force) {
      const cached = await getCached(client, tenantId, period, platform, sortBy);
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

    const snap    = await buildTopSnapshot(tenantId, period, platform, sortBy);
    const posts   = enrichPosts(snap);
    const pattern = buildPatternCard(snap);
    const hash    = inputHash(tenantId, period, platform, sortBy);

    const body: Record<string, unknown> = {
      posts,
      pattern,
      sortBy,
      meta: {
        postCount: snap.postCount,
        avgReach:  Math.round(snap.avgReach),
        hasData:   snap.posts.length > 0,
      },
    };

    await upsert(client, tenantId, period, platform, sortBy, body, hash);

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
