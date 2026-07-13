/**
 * backend/insights/attention/handler.ts
 *
 * Handles GET /api/insights/attention requests.
 *
 * Cache TTL is 15 minutes (shorter than other sections — unreplied count
 * changes when the user replies in Conversations, so staleness is more visible).
 * ?force=true bypasses cache.
 */

import { NextResponse } from 'next/server';
import pool, { type PoolClient } from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { buildAttentionSnapshot } from './attention-snapshot-builder';
import { buildAttentionCards } from './attention-card-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';
import crypto from 'crypto';

// v2: fix the unreplied-card CTA link (/conversations 404 → /dashboard/comments,
// S1-1/AA-80). Bump regenerates cached attention snapshots holding the bad link.
// v3: escape the untrusted post title in the opportunity-card HTML (stored XSS,
// S1-2/AA-81). Bump flushes cached cards holding the unescaped title.
// v4: S2-1 — the opportunity-card multiplier and best-day-of-week pattern now
// use the latest lifetime snapshot per post (not SUM across dated cumulative
// rows); since per-post inflation varied by sync age, the multiplier and DOW
// ranking change. Bump invalidates stale v3 bodies.
// v5: S2-3 — the period window and the best-day-of-week bucketing are now
// computed in the tenant's business timezone (weekday via AT TIME ZONE $tz, not
// UTC), so a post near midnight can move to a different weekday and the DOW
// ranking / window membership change. Bump invalidates stale v4 bodies.
const TEMPLATE_VERSION = 'attention-v5';
const CACHE_TTL_MS     = 15 * 60 * 1000; // 15 minutes

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
  period: string,
  platform: string,
): Promise<{ body: Record<string, unknown>; generatedAt: Date } | null> {
  const res = await client.query<{
    body: Record<string, unknown>;
    generated_at: Date;
    model: string;
  }>(
    `SELECT body, generated_at, model
     FROM insights_narratives
     WHERE tenant_id   = $1
       AND period      = $2
       AND platform    = $3
       AND section_key = 'attention'
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
  client: PoolClient,
  tenantId: number,
  period: string,
  platform: string,
  body: Record<string, unknown>,
  hash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO insights_narratives
       (tenant_id, period, platform, section_key, body, prompt_version, model, input_hash, cost_cents, generated_at)
     VALUES ($1, $2, $3, 'attention', $4, $5, $6, $7, 0, now())
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

export async function handleGetInsightsAttention(
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

    const snapshot = await buildAttentionSnapshot(tenantId, period, platform);
    const cards    = buildAttentionCards(snapshot, platform, period);
    const hash     = inputHash(tenantId, period, platform);

    const body: Record<string, unknown> = {
      cards,
      allCaughtUp: cards.length === 0,
      meta: {
        unreplied:     snapshot.unreplied,
        highPerformer: snapshot.highPerformer !== null,
        hasPattern:    snapshot.pattern !== null,
        hasMilestone:  snapshot.milestone !== null,
        postCount:     snapshot.postCount,
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
