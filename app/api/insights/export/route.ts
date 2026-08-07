import { NextResponse } from 'next/server';

import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { resolveTenantInsightsTimeZone } from '@/backend/insights/tenant-timezone';
import { tenantZonePeriodStartDateKey } from '@/lib/format-timestamp';
import { CSV_BOM, csvFilename, csvRow } from '@/backend/insights/export/csv';
import {
  DEFAULT_EXPORT_DAYS,
  MAX_EXPORT_DAYS,
  MAX_EXPORT_POST_ROWS,
  REFUSED_DATASETS,
  clampInt,
  isExportDataset,
  loadAccountMetricsDataset,
  loadPostsDataset,
  type DatasetResult,
} from '@/backend/insights/export/export-datasets';

/**
 * S5-3 / AA-112 (gap F2a) — GET /api/insights/export?dataset=posts|account-metrics
 *
 * Streams a tenant-scoped CSV of the operator's own insights data.
 *
 * Pool discipline (guardrail #1): the query is clamped, the pooled client is
 * RELEASED before a single byte is written to the response, and only then does
 * the body stream. Holding the client across the download would pin a
 * connection for as long as the operator's network takes — the export is not on
 * a hot path, but it is the one endpoint whose response time is bounded by the
 * client rather than the server.
 *
 * Comments are refused by name — see export-datasets.ts.
 */
export async function handleGetInsightsExport(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  if (!Number.isSafeInteger(tenantId) || tenantId < 1) {
    return NextResponse.json({ status: 'error', reason: 'tenant_context_required' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const dataset = searchParams.get('dataset');

  const refusal = dataset ? REFUSED_DATASETS[dataset] : undefined;
  if (refusal) {
    return NextResponse.json(
      { status: 'error', reason: 'dataset_not_exportable', message: refusal },
      { status: 400 },
    );
  }
  if (!isExportDataset(dataset)) {
    return NextResponse.json(
      { status: 'error', reason: 'unknown_dataset', message: 'Use dataset=posts or dataset=account-metrics.' },
      { status: 400 },
    );
  }

  const platformParam = searchParams.get('platform');
  const platform = !platformParam || platformParam === 'all' ? null : platformParam;
  const days = clampInt(Number(searchParams.get('days') ?? DEFAULT_EXPORT_DAYS), 1, MAX_EXPORT_DAYS);
  const limit = clampInt(
    Number(searchParams.get('limit') ?? MAX_EXPORT_POST_ROWS),
    1,
    MAX_EXPORT_POST_ROWS,
  );

  let result: DatasetResult;
  const client = await pool.connect();
  try {
    if (dataset === 'posts') {
      result = await loadPostsDataset(client, tenantId, platform, limit);
    } else {
      // S2-3: the account-metrics day window is a tenant-local calendar key.
      const tz = await resolveTenantInsightsTimeZone(client, tenantId);
      const fromKey = tenantZonePeriodStartDateKey(days, tz);
      result = await loadAccountMetricsDataset(client, tenantId, fromKey, platform);
    }
  } catch (error) {
    console.error('[insights-export] query failed', error);
    return NextResponse.json({ status: 'error', reason: 'export_unavailable' }, { status: 503 });
  } finally {
    // Released BEFORE streaming — see the pool note above.
    client.release();
  }

  const encoder = new TextEncoder();
  const { header, rows } = result;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(CSV_BOM));
      controller.enqueue(encoder.encode(csvRow(header)));
      for (const row of rows) {
        controller.enqueue(encoder.encode(csvRow(row)));
      }
      controller.close();
    },
  });

  const headers: Record<string, string> = {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${csvFilename(dataset)}"`,
    // An export is per-tenant and point-in-time; never let a shared cache hold it.
    'cache-control': 'no-store',
    'x-export-row-count': String(rows.length),
  };
  if (result.truncated) {
    // Silent truncation would read as "this is all my data". Say so.
    headers['x-export-truncated'] = 'true';
  }

  return new Response(stream, { status: 200, headers });
}

export async function GET(req: Request) {
  return handleGetInsightsExport(req);
}
