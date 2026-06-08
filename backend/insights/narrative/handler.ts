/**
 * backend/insights/narrative/handler.ts
 *
 * Handles GET /api/insights/narrative requests.
 *
 * Flow:
 *   1. Resolve tenant context.
 *   2. For platform != 'all': check integration is connected.
 *      If not → return { status: 'not_connected' } so the frontend can show a connect prompt.
 *   3. Check insights_narratives cache (TTL = 1 hour, keyed by tenant+period+platform).
 *   4. On cache miss: build snapshot → build text → store in DB → return.
 *   5. On cache hit: return stored narrative.
 *   6. Caller can pass ?force=true to skip cache and regenerate.
 */

import { NextResponse } from 'next/server';
import pool, { type PoolClient } from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { oauthStatusAsync } from '@/backend/integrations/status';
import { isSupportedPlatform } from '@/backend/insights/platforms/registry';
import { buildNarrativeSnapshot, type NarrativePeriod } from './snapshot-builder';
import { buildNarrativeText } from './template-builder';
import { computeAriesScore } from './score-builder';
import crypto from 'crypto';

const TEMPLATE_VERSION = 'template-v1';
const CACHE_TTL_MS     = 60 * 60 * 1000; // 1 hour

const VALID_PERIODS = new Set<string>(['week', '30day', '90day']);

function isValidPeriod(p: string | null): p is NarrativePeriod {
  return p != null && VALID_PERIODS.has(p);
}

async function isPlatformConnected(platform: string, tenantId: string): Promise<boolean> {
  try {
    const status = await oauthStatusAsync(platform, tenantId);
    if ('broker_status' in status) return false;
    return status.connection_status === 'connected';
  } catch {
    return false;
  }
}

function snapshotHash(tenantId: number, period: string, platform: string): string {
  return crypto
    .createHash('sha256')
    .update(`${tenantId}|${period}|${platform}|${TEMPLATE_VERSION}`)
    .digest('hex')
    .slice(0, 16);
}

async function getCachedNarrative(
  client: PoolClient,
  tenantId: number,
  period: string,
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
       AND section_key = 'hero'
     LIMIT 1`,
    [tenantId, period, platform],
  );

  if (res.rows.length === 0) return null;

  const row       = res.rows[0];
  const ageMs     = Date.now() - new Date(row.generated_at).getTime();
  const isFresh   = ageMs < CACHE_TTL_MS;
  const isCurrent = row.model === TEMPLATE_VERSION;

  if (!isFresh || !isCurrent) return null;
  return { body: row.body, generatedAt: row.generated_at };
}

async function upsertNarrative(
  client: PoolClient,
  tenantId: number,
  period: string,
  platform: string,
  body: Record<string, unknown>,
  inputHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO insights_narratives
       (tenant_id, period, platform, section_key, body, prompt_version, model, input_hash, cost_cents, generated_at)
     VALUES ($1, $2, $3, 'hero', $4, $5, $6, $7, 0, now())
     ON CONFLICT (tenant_id, period, platform, section_key)
     DO UPDATE SET
       body           = EXCLUDED.body,
       prompt_version = EXCLUDED.prompt_version,
       model          = EXCLUDED.model,
       input_hash     = EXCLUDED.input_hash,
       cost_cents     = 0,
       generated_at   = now()`,
    [tenantId, period, platform, JSON.stringify(body), TEMPLATE_VERSION, TEMPLATE_VERSION, inputHash],
  );
}

export async function handleGetInsightsNarrative(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const { searchParams } = new URL(req.url);
  const periodParam  = searchParams.get('period');
  const platformParam = (searchParams.get('platform') || 'all').toLowerCase();
  const force        = searchParams.get('force') === 'true';

  if (!isValidPeriod(periodParam)) {
    return NextResponse.json(
      { error: 'Invalid period. Use: week | 30day | 90day' },
      { status: 400 },
    );
  }

  const tenantId   = Number(tenantResult.tenantContext.tenantId);
  const tenantIdStr = String(tenantResult.tenantContext.tenantId);
  const period     = periodParam;
  const platform   = platformParam;

  // ── Connection check (skip for 'all') ────────────────────────────────────
  if (platform !== 'all' && isSupportedPlatform(platform)) {
    const connected = await isPlatformConnected(platform, tenantIdStr);
    if (!connected) {
      return NextResponse.json({
        status:      'not_connected',
        platform,
        connect_url: '/integrations',
      });
    }
  }

  const client = await pool.connect();
  try {
    // ── Cache hit ────────────────────────────────────────────────────────────
    if (!force) {
      const cached = await getCachedNarrative(client, tenantId, period, platform);
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

    // ── Cache miss: build snapshot + narrative ───────────────────────────────
    const snapshot  = await buildNarrativeSnapshot(tenantId, period, platform);
    const text      = buildNarrativeText(snapshot);
    const ariesScore = computeAriesScore(
      period,
      snapshot.engagementRate,
      snapshot.reachDelta,
      snapshot.engagementRatePrev,
    );
    const inputHash = snapshotHash(tenantId, period, platform);

    const body: Record<string, unknown> = {
      narrative: text,
      // Aries Score (Hero Band right side)
      score:     ariesScore.score,
      scoreDelta: ariesScore.scoreDelta,
      judgment:  ariesScore.judgment,
      // Period meta line (below narrative)
      periodMeta: {
        posts:       snapshot.posts,
        postsLabel:  snapshot.postsLabel,
        comments:    snapshot.comments,
        hoursSaved:  snapshot.hoursSaved,
      },
      snapshot: {
        posts:            snapshot.posts,
        postsLabel:       snapshot.postsLabel,
        reach:            snapshot.reach,
        reachDelta:       snapshot.reachDelta,
        reachLabel:       snapshot.reachLabel,
        engagementRate:   snapshot.engagementRate,
        topPost:          snapshot.topPost,
        unreplied:        snapshot.unreplied,
        watchTimeMinutes: snapshot.watchTimeMinutes,
        hasData:          snapshot.hasData,
      },
    };

    await upsertNarrative(client, tenantId, period, platform, body, inputHash);

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
