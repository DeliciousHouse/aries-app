/**
 * backend/insights/goal/handler.ts
 *
 * Handles GET /api/insights/goal requests.
 *
 * Flow:
 *   1. Resolve tenant context.
 *   2. Validate period param.
 *   3. Check insights_narratives cache (TTL = 1 hour, section_key = 'goal').
 *   4. On miss: build GoalSnapshot → build ariesLine text → upsert → return.
 *   5. If tenant has no primary_goal set → return { status: 'no_goal' }.
 *   6. Caller can pass ?force=true to skip cache.
 */

import { NextResponse } from 'next/server';
import pool, { type PoolClient } from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { buildGoalSnapshot } from './goal-snapshot-builder';
import { buildGoalText } from './goal-template-builder';
import type { NarrativePeriod } from '../narrative/snapshot-builder';
import crypto from 'crypto';

const TEMPLATE_VERSION = 'goal-template-v2';
const CACHE_TTL_MS     = 60 * 60 * 1000;

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
       AND section_key = 'goal'
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
     VALUES ($1, $2, $3, 'goal', $4, $5, $6, $7, 0, now())
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

export async function handleGetInsightsGoal(
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

    const snapshot = await buildGoalSnapshot(tenantId, period, platform);

    if (!snapshot) {
      return NextResponse.json({ status: 'no_goal' });
    }

    const ariesLine = buildGoalText(snapshot);
    const hash      = inputHash(tenantId, period, platform);

    const body: Record<string, unknown> = {
      goal:            snapshot.goal,
      goalLabel:       snapshot.goalLabel,
      ariesLine,
      metricValue:     snapshot.metricValue,
      metricValuePrev: snapshot.metricValuePrev,
      metricLabel:     snapshot.metricLabel,
      metricDelta:     snapshot.metricDelta,
      secondaryValue:  snapshot.secondaryValue,
      secondaryLabel:  snapshot.secondaryLabel,
      contributors:    snapshot.contributors,
      categories:      snapshot.categories,
      hasData:         snapshot.hasData,
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
