/**
 * T1 backfill — move legacy non-tenant-prefixed asset storage paths to the
 * new tenant-prefixed scheme:
 *
 *   ${DATA_ROOT}/ingested-assets/{sha[0:2]}/{sha}.{ext}
 *     → ${DATA_ROOT}/ingested-assets/{tenant_id}/{sha[0:2]}/{sha}.{ext}
 *
 * Each row in `creative_assets` whose `storage_key` still references the
 * legacy layout is moved on disk and the column updated to the new path.
 * The script is idempotent — a second run finds zero pending rows and
 * performs no work — and defaults to --dry-run; pass --commit to apply.
 *
 * Runbook
 * -------
 *   npx tsx scripts/migrate-asset-tenant-prefix.ts            # dry run (default)
 *   npx tsx scripts/migrate-asset-tenant-prefix.ts --commit   # apply
 *   DATA_ROOT=/tmp/snapshot npx tsx scripts/migrate-asset-tenant-prefix.ts
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';

import { resolveDataRoot } from '@/lib/runtime-paths';

const INGEST_SUBDIR = 'ingested-assets';

export type MigrationDb = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type MigrationOptions = {
  dryRun: boolean;
  db: MigrationDb;
  dataRoot?: string;
};

export type MigrationStats = {
  scanned: number;
  moved: number;
  updated: number;
  skipped: number;
  errors: number;
};

type LegacyRow = {
  id: string;
  tenant_id: number | string;
  storage_key: string;
};

const SELECT_LEGACY_ROWS = `
  SELECT id, tenant_id, storage_key
    FROM creative_assets
   WHERE storage_key IS NOT NULL
     AND storage_key <> ''
`;

const UPDATE_STORAGE_KEY = `
  UPDATE creative_assets
     SET storage_key = $1, updated_at = now()
   WHERE id = $2
`;

function ingestRootFor(dataRoot: string): string {
  return path.join(path.normalize(dataRoot), INGEST_SUBDIR);
}

function isLegacyStorageKey(storageKey: string, ingestRoot: string): boolean {
  const normalized = path.normalize(storageKey);
  const rel = path.relative(ingestRoot, normalized);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }
  const segments = rel.split(path.sep).filter(Boolean);
  // Legacy layout has exactly two segments after `ingested-assets/`:
  // [sha-prefix, filename]. Migrated layout has three:
  // [tenant_id, sha-prefix, filename].
  return segments.length === 2;
}

function tenantPrefixedPath(legacyAbs: string, tenantId: string, ingestRoot: string): string {
  const rel = path.relative(ingestRoot, path.normalize(legacyAbs));
  return path.join(ingestRoot, tenantId, rel);
}

function moveAtomically(src: string, dest: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  // If the destination already exists with the same bytes, the move was
  // performed by a prior run (or a concurrent ingest). Treat as a no-op and
  // just remove the source so the next idempotent pass sees a clean state.
  if (existsSync(dest)) {
    const srcSize = statSafeSize(src);
    const destSize = statSafeSize(dest);
    if (srcSize !== null && destSize !== null && srcSize === destSize) {
      try { unlinkSync(src); } catch {}
      return;
    }
    throw new Error(`migrate_destination_exists_with_different_size:${dest}`);
  }
  renameSync(src, dest);
}

function statSafeSize(filePath: string): number | null {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

function logInfo(message: string, fields?: Record<string, unknown>): void {
  if (fields) {
    process.stdout.write(`[migrate-asset-tenant-prefix] ${message} ${JSON.stringify(fields)}\n`);
    return;
  }
  process.stdout.write(`[migrate-asset-tenant-prefix] ${message}\n`);
}

function logWarn(message: string, fields?: Record<string, unknown>): void {
  if (fields) {
    process.stderr.write(`[migrate-asset-tenant-prefix] WARN ${message} ${JSON.stringify(fields)}\n`);
    return;
  }
  process.stderr.write(`[migrate-asset-tenant-prefix] WARN ${message}\n`);
}

export async function runAssetTenantPrefixMigration(
  options: MigrationOptions,
): Promise<MigrationStats> {
  const dataRoot = path.normalize(options.dataRoot ?? resolveDataRoot());
  const ingestRoot = ingestRootFor(dataRoot);
  const stats: MigrationStats = { scanned: 0, moved: 0, updated: 0, skipped: 0, errors: 0 };

  const result = await options.db.query(SELECT_LEGACY_ROWS);
  const rawRows = Array.isArray(result.rows) ? result.rows : [];
  const rows: LegacyRow[] = rawRows.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      id: String(record.id ?? ''),
      tenant_id: (record.tenant_id ?? '') as number | string,
      storage_key: String(record.storage_key ?? ''),
    };
  });
  const pending = rows.filter((row) => isLegacyStorageKey(row.storage_key, ingestRoot));
  stats.scanned = pending.length;

  for (const row of pending) {
    const tenantSegment = String(row.tenant_id ?? '').trim();
    if (!tenantSegment) {
      stats.errors += 1;
      logWarn('row missing tenant_id; skipping', { id: row.id });
      continue;
    }
    const legacyAbs = path.normalize(String(row.storage_key));
    const newAbs = tenantPrefixedPath(legacyAbs, tenantSegment, ingestRoot);

    if (legacyAbs === newAbs) {
      stats.skipped += 1;
      continue;
    }

    if (options.dryRun) {
      logInfo('would move', { id: row.id, from: legacyAbs, to: newAbs });
      continue;
    }

    if (!existsSync(legacyAbs)) {
      stats.errors += 1;
      logWarn('source file missing; cannot migrate', { id: row.id, source: legacyAbs });
      continue;
    }

    let lockFd: number | null = null;
    const lockPath = `${legacyAbs}.migrating.lock`;
    try {
      mkdirSync(path.dirname(lockPath), { recursive: true });
      try {
        lockFd = openSync(lockPath, 'wx');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
          stats.skipped += 1;
          logWarn('migration lock already held; skipping', { id: row.id, lock: lockPath });
          continue;
        }
        throw err;
      }

      moveAtomically(legacyAbs, newAbs);
      stats.moved += 1;

      const updateResult = await options.db.query(UPDATE_STORAGE_KEY, [newAbs, row.id]);
      const affected = updateResult.rowCount ?? 0;
      if (affected > 0) {
        stats.updated += 1;
      }
    } catch (err) {
      stats.errors += 1;
      logWarn('migration failed for row', {
        id: row.id,
        source: legacyAbs,
        dest: newAbs,
        error: (err as Error)?.message,
      });
    } finally {
      if (lockFd !== null) {
        try { closeSync(lockFd); } catch {}
      }
      try { unlinkSync(lockPath); } catch {}
    }
  }

  logInfo('summary', {
    dryRun: options.dryRun,
    scanned: stats.scanned,
    moved: stats.moved,
    updated: stats.updated,
    skipped: stats.skipped,
    errors: stats.errors,
  });

  return stats;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry.endsWith('migrate-asset-tenant-prefix.ts') ||
      entry.endsWith('migrate-asset-tenant-prefix.js');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void (async () => {
    const dryRun = !process.argv.includes('--commit');
    const { pool } = await import('@/lib/db');
    try {
      await runAssetTenantPrefixMigration({ dryRun, db: pool });
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
