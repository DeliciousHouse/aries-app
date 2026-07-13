/**
 * backend/insights/activity/handler.ts
 *
 * Handles GET /api/insights/activity requests.
 *
 * Returns Section 4 — "What Aries Did":
 *   - activity strip (postsPublished, commentsReceived, highPerformers, hoursSaved)
 *   - footerLine for the strip
 *   - contentMix array for the donut chart
 *
 * Cache TTL: 1 hour. The strip numbers change only when new posts/comments
 * are synced, so hourly freshness is sufficient.
 * ?force=true bypasses cache.
 */

import { NextResponse } from 'next/server';
import pool, { type PoolClient } from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { buildActivitySnapshot } from './activity-snapshot-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';
import crypto from 'crypto';

// v4: S2-1 — the high-performers count (posts ≥2× average reach) now compares
// latest lifetime snapshots per post, not SUM across dated cumulative rows.
// Because per-post inflation varied by sync age, the threshold basis and the
// resulting count shift. Bump invalidates stale v3 bodies.
const TEMPLATE_VERSION = 'activity-v4';
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
  client: PoolClient,
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
       AND section_key = 'activity'
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
     VALUES ($1, $2, $3, 'activity', $4, $5, $6, $7, 0, now())
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

// An insight line — NOT a restatement of the posts-published count (which has
// its own card). Surfaces what Aries noticed: the leading content type when one
// clearly dominates, otherwise the always-true learning message.
function buildFooterLine(snap: { postsPublished: number; contentMix: Array<{ contentType: string; pct: number }> }): string {
  if (snap.postsPublished === 0) {
    return 'No Aries-published posts in this period.';
  }
  const top = snap.contentMix[0];
  if (top && top.contentType !== 'uncategorized' && top.pct >= 35) {
    const label = top.contentType.charAt(0).toUpperCase() + top.contentType.slice(1);
    return `${label} content is leading your mix this period — Aries is leaning into what's working.`;
  }
  return 'Aries learns from every comment, save, and click — content quality compounds week over week.';
}

export async function handleGetInsightsActivity(
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

    const snap = await buildActivitySnapshot(tenantId, period, platform);
    const hash = inputHash(tenantId, period, platform);

    const body: Record<string, unknown> = {
      strip: {
        postsPublished:    snap.postsPublished,
        commentsReceived:  snap.commentsReceived,
        commentsHandled:   snap.commentsHandled,
        commentsNeedReply: snap.commentsNeedReply,
        highPerformers:    snap.highPerformers,
        hoursSaved:        snap.hoursSaved,
      },
      footerLine: buildFooterLine(snap),
      contentMix: snap.contentMix,
      meta: {
        platformCount:         snap.platformCount,
        platforms:             snap.platforms,
        pendingClassification: snap.pendingClassification,
        hasData:               snap.postsPublished > 0,
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
