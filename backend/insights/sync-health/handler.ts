/**
 * backend/insights/sync-health/handler.ts
 *
 * S6-3 / AA-116 (gap F4a) — GET /api/insights/sync-health
 *
 * Per-tenant recent sync runs with status and failure reason. Powers the S1-3
 * freshness stamp's detail view: the stamp says "stale", this says why.
 *
 * UNCACHED, like the freshness stamp it explains — a cached health view would
 * report a sync as broken after it recovered, or healthy after it broke.
 *
 * Guardrail #1: one clamped, tenant-scoped query on one pooled client.
 *
 * ROLE BOUNDARY. `error_message` is raw third-party adapter text and never leaves
 * the server. Admins receive a bounded category-specific action; every other role
 * receives only the coarse category.
 */

import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import {
  classifySyncFailure,
  isRestartAbort,
  summarizeByPlatform,
  type SyncRunRow,
  type SyncRunStatus,
} from './sync-health-logic';

/** Hard ceiling on returned runs — this is an append-only audit table. */
export const MAX_SYNC_HEALTH_RUNS = 50;
export const DEFAULT_SYNC_HEALTH_RUNS = 20;

/** $1 tenant, $2 platform-or-null, $3 limit. */
export const SYNC_HEALTH_RUNS_SQL = `
  SELECT
    r.id             AS id,
    r.platform       AS platform,
    r.trigger        AS trigger,
    r.started_at     AS started_at,
    r.finished_at    AS finished_at,
    r.status         AS status,
    r.posts_seen     AS posts_seen,
    r.comments_seen  AS comments_seen,
    r.api_units_used AS api_units_used,
    r.error_message  AS error_message
  FROM (
    SELECT
      r.*,
      ROW_NUMBER() OVER (
        PARTITION BY r.platform
        ORDER BY COALESCE(r.finished_at, r.started_at) DESC, r.id DESC
      ) AS rn
    FROM insights_sync_runs r
    WHERE r.tenant_id = $1
      AND ($2::text IS NULL OR r.platform = $2)
  ) r
  WHERE r.rn <= $3
  ORDER BY COALESCE(r.finished_at, r.started_at) DESC, r.id DESC
`;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface SyncHealthQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

interface SyncHealthPool {
  connect(): Promise<SyncHealthQueryable & { release(): void }>;
}

export function safeSyncFailureDetail(errorMessage: string | null): string {
  switch (classifySyncFailure(errorMessage)) {
    case 'auth': return 'Authentication failed; reconnect the account.';
    case 'rate_limit': return 'Provider rate limit reached; retry later.';
    case 'not_configured': return 'The integration is not configured.';
    case 'restart_abort': return 'The sync was interrupted by an application restart.';
    default: return 'The provider sync failed.';
  }
}

export function aggregateFailureStreak(
  platforms: ReturnType<typeof summarizeByPlatform>,
): number {
  return Math.max(0, ...platforms.map((platform) => platform.consecutiveFailures));
}

export async function loadSyncRuns(
  db: SyncHealthQueryable,
  tenantId: number,
  platform: string | null,
  limit: number,
): Promise<SyncRunRow[]> {
  const cap = clampInt(limit, 1, MAX_SYNC_HEALTH_RUNS);
  const { rows } = await db.query<Record<string, unknown>>(SYNC_HEALTH_RUNS_SQL, [
    tenantId,
    platform,
    cap,
  ]);
  return rows.map((r) => ({
    id: Number(r.id),
    platform: String(r.platform ?? 'unknown'),
    trigger: String(r.trigger ?? 'unknown'),
    startedAt: toIso(r.started_at as Date) ?? '',
    finishedAt: toIso(r.finished_at as Date | null),
    status: String(r.status ?? 'running') as SyncRunStatus,
    postsSeen: Number(r.posts_seen ?? 0),
    commentsSeen: Number(r.comments_seen ?? 0),
    apiUnitsUsed: Number(r.api_units_used ?? 0),
    errorMessage: (r.error_message as string | null) ?? null,
  }));
}

export async function handleGetInsightsSyncHealth(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
  dbPool: SyncHealthPool = pool,
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  if (!Number.isSafeInteger(tenantId) || tenantId < 1) {
    return NextResponse.json({ status: 'error', reason: 'tenant_context_required' }, { status: 403 });
  }
  const isAdmin = tenantResult.tenantContext.role === 'tenant_admin';

  const { searchParams } = new URL(req.url);
  const platformParam = searchParams.get('platform');
  const platform = !platformParam || platformParam === 'all' ? null : platformParam;
  const limit = clampInt(
    Number(searchParams.get('limit') ?? DEFAULT_SYNC_HEALTH_RUNS),
    1,
    MAX_SYNC_HEALTH_RUNS,
  );

  let client: (SyncHealthQueryable & { release(): void }) | undefined;
  let runs: SyncRunRow[];
  try {
    client = await dbPool.connect();
    runs = await loadSyncRuns(client, tenantId, platform, limit);
  } catch (error) {
    console.error('[insights-sync-health] query failed', error);
    return NextResponse.json({ status: 'error', reason: 'sync_health_unavailable' }, { status: 503 });
  } finally {
    client?.release();
  }

  const platforms = summarizeByPlatform(runs);
  const body = {
    status: 'ok' as const,
    consecutiveFailures: aggregateFailureStreak(platforms),
    platforms,
    runs: runs.map((run) => ({
      id: run.id,
      platform: run.platform,
      trigger: run.trigger,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs:
        run.finishedAt && run.startedAt
          ? Math.max(0, new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
          : null,
      status: run.status,
      postsSeen: run.postsSeen,
      commentsSeen: run.commentsSeen,
      apiUnitsUsed: run.apiUnitsUsed,
      // A restart-abort is reported as what it is — an interrupted run, not a
      // broken integration — so nobody chases a deploy artifact as an incident.
      restartAbort: isRestartAbort(run),
      failureCategory: run.status === 'failed' ? classifySyncFailure(run.errorMessage) : null,
      // Admin only, but still category-safe: provider bodies and credentials are never returned.
      failureReason: isAdmin && run.status === 'failed' ? safeSyncFailureDetail(run.errorMessage) : null,
    })),
    meta: {
      limit,
      platform: platform ?? 'all',
      /** Tells the UI whether a null failureReason means "none" or "not yours". */
      canSeeFailureDetail: isAdmin,
    },
  };

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
