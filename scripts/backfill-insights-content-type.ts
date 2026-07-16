/**
 * Backfill `insights_posts.content_type` for pre-existing rows.
 *
 * The sync dispatcher (backend/insights/sync/dispatcher.ts) only stamps
 * content_type for posts it upserts on future syncs (the `fetchPostList`
 * recent window). This script applies the same caption-keyword heuristic
 * (backend/insights/sync/classify-post.ts) to HISTORY: every existing row
 * with content_type IS NULL.
 *
 * Idempotent: only ever updates rows where content_type IS NULL — running it
 * twice is a no-op the second time (mirrors the sync dispatcher's
 * COALESCE-preserve conflict rule; a stamped row is never rewritten).
 *
 * Sequential batched loop by id cursor (guardrail #1 — no Promise.all around
 * PostgreSQL). Default batch size 500.
 *
 * Usage:
 *   tsx scripts/backfill-insights-content-type.ts --tenant 15 --dry-run
 *   tsx scripts/backfill-insights-content-type.ts --tenant 15
 *   tsx scripts/backfill-insights-content-type.ts --all --dry-run
 *   tsx scripts/backfill-insights-content-type.ts --all
 *
 * --dry-run classifies and prints the bucket distribution + coverage report
 * but mutates nothing — the coverage gate (docs/plans/2026-07-16-content-type-
 * production-writer.md §9.1): run this FIRST on the live tenant and record
 * combinedPctClassified before deciding whether the heuristic alone clears
 * the ≥60% acceptance bar. Coverage is computed over the FULL scanned scope
 * (preClassified rows that were already non-NULL when the run started, plus
 * newlyClassifiable rows this run classified) — not just the rows still
 * NULL at run time, which would bias the gate downward once the sync
 * dispatcher has already stamped some recent rows.
 */

import path from 'node:path';

import { classifyPostContentType, CONTENT_TYPES, type ContentType } from '@/backend/insights/sync/classify-post';

const BATCH_SIZE = 500;

type Row = {
  id: number;
  tenant_id: number;
  caption: string | null;
  title: string | null;
  media_type: string | null;
};

type Db = {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

function parseArgs(argv: string[]): { tenant: number | null; all: boolean; dryRun: boolean } {
  let tenant: number | null = null;
  let all = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant') {
      const next = argv[i + 1];
      const parsed = next ? Number(next) : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--tenant requires a positive integer id, got: ${next ?? '(missing)'}`);
      }
      tenant = parsed;
      i += 1;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }
  return { tenant, all, dryRun };
}

function logInfo(message: string, fields?: Record<string, unknown>): void {
  process.stdout.write(
    fields
      ? `[backfill-insights-content-type] ${message} ${JSON.stringify(fields)}\n`
      : `[backfill-insights-content-type] ${message}\n`,
  );
}

function logWarn(message: string, fields?: Record<string, unknown>): void {
  process.stderr.write(
    fields
      ? `[backfill-insights-content-type] WARN ${message} ${JSON.stringify(fields)}\n`
      : `[backfill-insights-content-type] WARN ${message}\n`,
  );
}

export type BackfillStats = {
  scanned: number;
  classified: number;
  rowsUpdated: number;
  errors: number;
  buckets: Record<ContentType, number>;
  /** Rows already non-NULL at run time — counted from a cheap COUNT(*) taken
   *  BEFORE the loop so the coverage report can state coverage over the full
   *  scanned scope, not just the rows still NULL at run time (the sync
   *  dispatcher stamps content_type on new rows going forward, so by the
   *  time this backfill runs a growing share of the scope may already be
   *  classified — omitting that share biased the plan §9.1 60% gate
   *  downward). */
  preClassified: number;
};

function emptyBuckets(): Record<ContentType, number> {
  const buckets = {} as Record<ContentType, number>;
  for (const type of CONTENT_TYPES) buckets[type] = 0;
  return buckets;
}

export async function runBackfillInsightsContentType(options: {
  db: Db;
  tenantId?: number | null;
  dryRun: boolean;
  batchSize?: number;
}): Promise<BackfillStats> {
  const { db, tenantId, dryRun } = options;
  const batchSize = options.batchSize ?? BATCH_SIZE;

  const stats: BackfillStats = {
    scanned: 0,
    classified: 0,
    rowsUpdated: 0,
    errors: 0,
    buckets: emptyBuckets(),
    preClassified: 0,
  };

  // Cheap COUNT(*) over the full scanned scope, grouped by whether
  // content_type is already set — taken BEFORE the loop so pre-existing
  // non-NULL rows are counted as classified in both the numerator and the
  // denominator of the coverage report (see BackfillStats.preClassified).
  {
    const countParams: unknown[] = tenantId ? [tenantId] : [];
    const tenantFilter = tenantId ? 'WHERE tenant_id = $1' : '';
    const countResult = await db.query<{ content_type_is_null: boolean; count: string }>(
      `SELECT content_type IS NULL AS content_type_is_null, COUNT(*) AS count
         FROM insights_posts
         ${tenantFilter}
        GROUP BY content_type IS NULL`,
      countParams,
    );
    for (const row of countResult.rows) {
      if (!row.content_type_is_null) {
        stats.preClassified += Number(row.count);
      }
    }
  }

  let cursor = 0;
  for (;;) {
    const params: unknown[] = tenantId ? [cursor, tenantId, batchSize] : [cursor, batchSize];
    const tenantFilter = tenantId ? 'AND tenant_id = $2' : '';
    const limitParam = tenantId ? '$3' : '$2';
    const result = await db.query<Row>(
      `SELECT id, tenant_id, caption, title, media_type
         FROM insights_posts
        WHERE content_type IS NULL
          AND id > $1
          ${tenantFilter}
        ORDER BY id ASC
        LIMIT ${limitParam}`,
      params,
    );
    const rows = result.rows;
    if (rows.length === 0) break;

    // Sequential — no Promise.all around pg (guardrail #1).
    for (const row of rows) {
      stats.scanned += 1;
      cursor = row.id;

      const contentType = classifyPostContentType({
        caption: row.caption,
        title: row.title,
        mediaType: row.media_type,
      });

      if (!contentType) continue;
      stats.classified += 1;
      stats.buckets[contentType] += 1;

      if (dryRun) continue;

      try {
        const update = await db.query(
          `UPDATE insights_posts
              SET content_type = $2
            WHERE id = $1
              AND content_type IS NULL`,
          [row.id, contentType],
        );
        if ((update.rowCount ?? 0) > 0) stats.rowsUpdated += 1;
      } catch (err) {
        stats.errors += 1;
        logWarn('update failed', { id: row.id, error: (err as Error)?.message });
      }
    }

    if (rows.length < batchSize) break;
  }

  return stats;
}

function printReport(stats: BackfillStats, dryRun: boolean): void {
  // Coverage must be stated over ALL rows of the scanned scope (plan §9.1's
  // 60% gate), not just the rows still NULL at run time — pre-existing
  // non-NULL rows count as classified in both the numerator and the
  // denominator, printed distinctly from the newly-classifiable count.
  const totalScope = stats.preClassified + stats.scanned;
  const combinedClassified = stats.preClassified + stats.classified;
  const pctClassified = totalScope > 0 ? ((combinedClassified / totalScope) * 100).toFixed(1) : '0.0';
  logInfo('bucket distribution', { ...stats.buckets });
  logInfo('summary', {
    dryRun,
    scanned: stats.scanned,
    preClassified: stats.preClassified,
    newlyClassifiable: stats.classified,
    combinedClassified,
    totalScope,
    combinedPctClassified: `${pctClassified}%`,
    rowsUpdated: stats.rowsUpdated,
    errors: stats.errors,
  });
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry.endsWith('backfill-insights-content-type.ts') || entry.endsWith('backfill-insights-content-type.js');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void (async () => {
    let tenant: number | null;
    let all: boolean;
    let dryRun: boolean;
    try {
      ({ tenant, all, dryRun } = parseArgs(process.argv.slice(2)));
    } catch (err) {
      logWarn('FATAL', { error: (err as Error)?.message });
      process.exit(1);
      return;
    }
    if (!tenant && !all) {
      logWarn('FATAL', { error: 'pass either --tenant <id> or --all' });
      process.exit(1);
      return;
    }
    if (tenant && all) {
      logWarn('FATAL', { error: 'pass either --tenant <id> or --all, not both' });
      process.exit(1);
      return;
    }

    const { pool } = await import('@/lib/db');
    try {
      const stats = await runBackfillInsightsContentType({ db: pool, tenantId: tenant, dryRun });
      printReport(stats, dryRun);
    } catch (err) {
      logWarn('FATAL', { error: (err as Error)?.message });
      process.exit(1);
    } finally {
      try {
        await pool.end();
      } catch {
        // ignore pool shutdown errors
      }
    }
  })();
}
