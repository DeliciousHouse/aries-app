import { pathToFileURL } from 'node:url';

export type BackfillQueryable = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export type BackfillOptions = {
  /** Explicit tenant scope. null means an explicit --all scope. */
  tenantId: number | null;
  /** Mutation is opt-in; omitted/false is always dry-run. */
  write?: boolean;
  batchSize?: number;
  log?: (message: string) => void;
};

export type BackfillReport = {
  mode: 'dry-run' | 'write';
  candidates: number;
  updated: number;
  batches: number;
};

type CandidateRow = {
  insights_post_id: number | string;
  tenant_id: number | string;
  aries_post_id: number | string;
};

const DEFAULT_BATCH_SIZE = 500;

/**
 * Find rows that can be attributed from the same sources used by live sync:
 * a per-platform scheduled child first, then legacy posts.platform_post_id.
 * The platform and tenant predicates prevent cross-tenant/cross-platform links.
 */
const CANDIDATE_QUERY = `
  SELECT ip.id AS insights_post_id,
         ip.tenant_id,
         candidate.aries_post_id
  FROM insights_posts ip
  JOIN LATERAL (
    SELECT source.aries_post_id
    FROM (
      SELECT p.id AS aries_post_id,
             2 AS source_priority,
             p.published_at AS event_at
      FROM posts p
      WHERE p.tenant_id = ip.tenant_id
        AND p.platform_post_id = ip.external_post_id
        AND p.published_status IN ('published', 'unverified')
        AND CASE WHEN lower(p.platform) = 'meta' THEN 'facebook' ELSE lower(p.platform) END
            = CASE WHEN lower(ip.platform) = 'meta' THEN 'facebook' ELSE lower(ip.platform) END

      UNION ALL

      SELECT sp.post_id AS aries_post_id,
             1 AS source_priority,
             d.dispatched_at AS event_at
      FROM scheduled_post_dispatches d
      JOIN scheduled_posts sp ON sp.id = d.scheduled_post_id
      WHERE sp.tenant_id = ip.tenant_id
        AND d.status = 'dispatched'
        AND d.platform_post_id = ip.external_post_id
        AND CASE WHEN lower(d.platform) = 'meta' THEN 'facebook' ELSE lower(d.platform) END
            = CASE WHEN lower(ip.platform) = 'meta' THEN 'facebook' ELSE lower(ip.platform) END
    ) source
    ORDER BY source.source_priority ASC,
             source.event_at DESC NULLS LAST,
             source.aries_post_id DESC
    LIMIT 1
  ) candidate ON true
  WHERE ip.id > $1
    AND ip.aries_post_id IS NULL
    AND ($3::int IS NULL OR ip.tenant_id = $3)
  ORDER BY ip.id
  LIMIT $2
`;

const UPDATE_QUERY = `
  UPDATE insights_posts
  SET aries_post_id = $1
  WHERE id = $2
    AND tenant_id = $3
    AND aries_post_id IS NULL
  RETURNING id
`;

function positiveInteger(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function parseBackfillArgs(argv: string[]): {
  write: boolean;
  tenantId: number | null;
  batchSize: number;
} {
  let write = false;
  let dryRun = false;
  let tenantId: number | null = null;
  let tenantScopeSeen = false;
  let allScopeSeen = false;
  let batchSize = DEFAULT_BATCH_SIZE;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--all') {
      allScopeSeen = true;
      continue;
    }
    if (arg === '--tenant') {
      const rawTenantId = argv[index + 1];
      if (!rawTenantId) throw new Error('--tenant requires a positive integer');
      tenantId = positiveInteger(rawTenantId, '--tenant');
      tenantScopeSeen = true;
      index += 1;
      continue;
    }
    if (arg === '--batch-size') {
      const rawBatchSize = argv[index + 1];
      if (!rawBatchSize) throw new Error('--batch-size requires a positive integer');
      batchSize = positiveInteger(rawBatchSize, '--batch-size');
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') continue;
    throw new Error(`unknown argument: ${arg}`);
  }

  if (write && dryRun) throw new Error('--write and --dry-run are mutually exclusive');
  if (tenantScopeSeen && allScopeSeen) throw new Error('--tenant and --all are mutually exclusive');
  if (!tenantScopeSeen && !allScopeSeen) {
    throw new Error('an explicit scope is required: pass --tenant <id> or --all');
  }

  return { write, tenantId, batchSize };
}

export async function backfillInsightsAttribution(
  db: BackfillQueryable,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const write = options.write === true;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const tenantId = options.tenantId;
  const log = options.log ?? console.log;

  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer');
  }
  if (tenantId !== null && (!Number.isSafeInteger(tenantId) || tenantId < 1)) {
    throw new Error('tenantId must be a positive integer or null for explicit all-tenant scope');
  }

  const report: BackfillReport = {
    mode: write ? 'write' : 'dry-run',
    candidates: 0,
    updated: 0,
    batches: 0,
  };
  let cursor = '0';

  log(`[insights-attribution-backfill] mode=${report.mode} scope=${tenantId === null ? 'all' : `tenant:${tenantId}`} batchSize=${batchSize}`);

  while (true) {
    const batch = await db.query<CandidateRow>(CANDIDATE_QUERY, [cursor, batchSize, tenantId]);
    if (batch.rows.length === 0) break;

    report.batches += 1;
    report.candidates += batch.rows.length;

    if (write) {
      for (const row of batch.rows) {
        const updated = await db.query(UPDATE_QUERY, [
          row.aries_post_id,
          row.insights_post_id,
          row.tenant_id,
        ]);
        report.updated += updated.rowCount ?? 0;
      }
    }

    cursor = String(batch.rows[batch.rows.length - 1].insights_post_id);
    log(`[insights-attribution-backfill] batch=${report.batches} candidates=${batch.rows.length} cursor=${cursor} updated=${report.updated}`);
  }

  log(`[insights-attribution-backfill] complete ${JSON.stringify(report)}`);
  return report;
}

function usage(): string {
  return [
    'Usage: npx tsx scripts/backfill-insights-attribution.ts (--tenant <id> | --all) [--dry-run | --write] [--batch-size <n>]',
    '',
    'Safety defaults:',
    '  - An explicit --tenant or --all scope is mandatory.',
    '  - Omit --write to run read-only dry-run mode.',
    '  - Mutation requires the explicit --write flag.',
  ].join('\n');
}

async function runFromCli(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }

  const options = parseBackfillArgs(argv);
  const { default: pool } = await import('../lib/db');
  try {
    await backfillInsightsAttribution(pool, options);
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  runFromCli().catch((error) => {
    console.error(`[insights-attribution-backfill] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
