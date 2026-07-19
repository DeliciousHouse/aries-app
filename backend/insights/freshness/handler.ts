/**
 * backend/insights/freshness/handler.ts
 *
 * GET /api/insights/freshness — the data-freshness stamp for the /insights
 * header (S1-3 / AA-82).
 *
 * UNCACHED BY DESIGN. Reads ONLY insights_accounts + insights_sync_runs. It does
 * NOT touch insights_narratives, has NO TEMPLATE_VERSION, and returns
 * Cache-Control: no-store — a cached freshness stamp would defeat its purpose.
 *
 * The single stamp reflects the least-fresh connected account and is derived
 * from run STATUS (ok|partial|failed), so "sync broke / data is stale" is
 * distinguishable from "engagement is genuinely flat". See freshness-logic.ts.
 */

import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { resolveInsightsStaleMs } from './config';
import { computeFreshness, type AccountSyncRow } from './freshness-logic';

async function queryAccountSyncState(tenantId: number): Promise<AccountSyncRow[]> {
  const res = await pool.query<{
    platform:        string;
    display_name:    string | null;
    latest_status:   'ok' | 'partial' | 'failed' | null;
    last_success_at: Date | null;
  }>(
    `WITH latest_run AS (
       SELECT DISTINCT ON (account_id) account_id, status
       FROM insights_sync_runs
       WHERE tenant_id = $1 AND status IN ('ok','partial','failed')
       ORDER BY account_id, COALESCE(finished_at, started_at) DESC
     ),
     last_success AS (
       SELECT account_id, MAX(finished_at) AS last_success_at
       FROM insights_sync_runs
       WHERE tenant_id = $1 AND status IN ('ok','partial') AND finished_at IS NOT NULL
       GROUP BY account_id
     )
     SELECT a.platform,
            a.display_name,
            lr.status          AS latest_status,
            ls.last_success_at
     FROM insights_accounts a
     LEFT JOIN latest_run   lr ON lr.account_id = a.id
     LEFT JOIN last_success ls ON ls.account_id = a.id
     WHERE a.tenant_id = $1
     ORDER BY a.platform`,
    [tenantId],
  );

  return res.rows.map((r) => ({
    platform:      r.platform,
    displayName:   r.display_name,
    latestStatus:  r.latest_status,
    lastSuccessAt: r.last_success_at,
  }));
}

export async function handleGetInsightsFreshness(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const rows     = await queryAccountSyncState(tenantId);
  const freshness = computeFreshness(rows, new Date(), resolveInsightsStaleMs());

  // no-store: the freshness stamp must never be served stale.
  return NextResponse.json(freshness, { headers: { 'Cache-Control': 'no-store' } });
}
