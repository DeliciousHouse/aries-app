/**
 * T15 — Orphan asset garbage collector.
 *
 * Upload-replace marks the previous creative as orphaned_at = now() so the
 * runtime keeps audit history for 24h before reclaiming bytes. This script
 * is the reclaim half: it sweeps `creative_assets` rows whose orphaned_at
 * is older than the retention window, removes the file from disk, and
 * deletes the row.
 *
 * Default: --dry-run (lists candidates, mutates nothing).
 * --commit: applies deletes.
 *
 *   npx tsx scripts/gc-orphan-uploads.ts                 # dry run
 *   npx tsx scripts/gc-orphan-uploads.ts --commit        # apply
 *   npx tsx scripts/gc-orphan-uploads.ts --max-age-hours 24 --commit
 */

import { existsSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';

import { resolveDataRoot } from '@/lib/runtime-paths';

const DEFAULT_RETENTION_HOURS = 24;

export type GcDb = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type GcOrphanOptions = {
  dryRun: boolean;
  db: GcDb;
  maxAgeHours?: number;
  dataRoot?: string;
  now?: () => Date;
};

export type GcOrphanCandidate = {
  id: string;
  tenantId: string;
  storageKey: string | null;
  orphanedAt: string;
  fileExists: boolean;
};

export type GcOrphanStats = {
  scanned: number;
  filesDeleted: number;
  rowsDeleted: number;
  fileMissing: number;
  errors: number;
  candidates: GcOrphanCandidate[];
};

const SELECT_ORPHANS_SQL = `
  SELECT id, tenant_id, storage_key, orphaned_at
    FROM creative_assets
   WHERE orphaned_at IS NOT NULL
     AND orphaned_at < $1
   ORDER BY orphaned_at ASC
`;

const DELETE_ROW_SQL = `
  DELETE FROM creative_assets
   WHERE id = $1
     AND orphaned_at IS NOT NULL
     AND orphaned_at < $2
`;

function logInfo(message: string, fields?: Record<string, unknown>): void {
  if (fields) {
    process.stdout.write(`[gc-orphan-uploads] ${message} ${JSON.stringify(fields)}\n`);
    return;
  }
  process.stdout.write(`[gc-orphan-uploads] ${message}\n`);
}

function logWarn(message: string, fields?: Record<string, unknown>): void {
  if (fields) {
    process.stderr.write(`[gc-orphan-uploads] WARN ${message} ${JSON.stringify(fields)}\n`);
    return;
  }
  process.stderr.write(`[gc-orphan-uploads] WARN ${message}\n`);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isInTenantIngestPath(absPath: string, tenantId: string, ingestRoot: string): boolean {
  const rel = path.relative(ingestRoot, path.normalize(absPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const segments = rel.split(path.sep).filter(Boolean);
  return segments.length >= 1 && segments[0] === tenantId;
}

export async function runGcOrphanUploads(options: GcOrphanOptions): Promise<GcOrphanStats> {
  const stats: GcOrphanStats = {
    scanned: 0,
    filesDeleted: 0,
    rowsDeleted: 0,
    fileMissing: 0,
    errors: 0,
    candidates: [],
  };

  const dataRoot = path.normalize(options.dataRoot ?? resolveDataRoot());
  const ingestRoot = path.join(dataRoot, 'ingested-assets');
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_RETENTION_HOURS;
  const now = options.now ? options.now() : new Date();
  const cutoff = new Date(now.getTime() - maxAgeHours * 60 * 60 * 1000);

  const result = await options.db.query(SELECT_ORPHANS_SQL, [cutoff.toISOString()]);
  const rawRows = Array.isArray(result.rows) ? result.rows : [];

  for (const entry of rawRows) {
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? '');
    const tenantId = String(record.tenant_id ?? '');
    const storageKey = typeof record.storage_key === 'string' ? record.storage_key : null;
    const orphanedAtRaw = record.orphaned_at;
    const orphanedAt =
      orphanedAtRaw instanceof Date
        ? orphanedAtRaw.toISOString()
        : typeof orphanedAtRaw === 'string'
          ? orphanedAtRaw
          : '';
    if (!id || !tenantId) {
      stats.errors += 1;
      logWarn('row missing id or tenant_id; skipping', { id, tenantId });
      continue;
    }

    stats.scanned += 1;
    const fileExists =
      typeof storageKey === 'string' && storageKey.length > 0
        ? existsSync(storageKey)
        : false;
    const candidate: GcOrphanCandidate = {
      id,
      tenantId,
      storageKey,
      orphanedAt,
      fileExists,
    };
    stats.candidates.push(candidate);

    if (options.dryRun) {
      logInfo('would delete', candidate);
      continue;
    }

    if (storageKey) {
      const safe =
        isWithinRoot(ingestRoot, storageKey) &&
        isInTenantIngestPath(storageKey, tenantId, ingestRoot);
      if (!safe) {
        stats.errors += 1;
        logWarn('storage_key outside tenant ingest root; refusing to delete file', {
          id,
          tenantId,
          storage_key: storageKey,
        });
      } else if (!fileExists) {
        stats.fileMissing += 1;
        logInfo('file already absent; row will still be cleared', { id, storageKey });
      } else {
        try {
          const sizeBefore = statSync(storageKey).size;
          unlinkSync(storageKey);
          stats.filesDeleted += 1;
          logInfo('deleted file', { id, storageKey, bytes: sizeBefore });
        } catch (err) {
          stats.errors += 1;
          logWarn('file delete failed', { id, storageKey, error: (err as Error)?.message });
          continue;
        }
      }
    }

    try {
      const deleteResult = await options.db.query(DELETE_ROW_SQL, [id, cutoff.toISOString()]);
      const affected = deleteResult.rowCount ?? 0;
      if (affected > 0) {
        stats.rowsDeleted += 1;
        logInfo('deleted row', { id });
      }
    } catch (err) {
      stats.errors += 1;
      logWarn('row delete failed', { id, error: (err as Error)?.message });
    }
  }

  logInfo('summary', {
    dryRun: options.dryRun,
    maxAgeHours,
    cutoff: cutoff.toISOString(),
    scanned: stats.scanned,
    filesDeleted: stats.filesDeleted,
    rowsDeleted: stats.rowsDeleted,
    fileMissing: stats.fileMissing,
    errors: stats.errors,
  });

  return stats;
}

function parseMaxAgeHours(argv: string[]): number {
  const flagIdx = argv.indexOf('--max-age-hours');
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    const parsed = Number(argv[flagIdx + 1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_RETENTION_HOURS;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry.endsWith('gc-orphan-uploads.ts') || entry.endsWith('gc-orphan-uploads.js');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void (async () => {
    const dryRun = !process.argv.includes('--commit');
    const maxAgeHours = parseMaxAgeHours(process.argv);
    const { pool } = await import('@/lib/db');
    try {
      await runGcOrphanUploads({ dryRun, db: pool, maxAgeHours });
    } catch (err) {
      logWarn('FATAL', { error: (err as Error)?.message });
      process.exit(1);
    } finally {
      try {
        await pool.end();
      } catch {}
    }
  })();
}
