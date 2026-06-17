/**
 * Missing-Hermes-asset garbage collector.
 *
 * Hermes-generated creatives (`storage_kind = 'runtime_asset'`) live in the
 * Hermes image cache, bind-mounted read-only as `HERMES_IMAGE_CACHE_MOUNT`.
 * That cache evicts old images, but the `creative_assets` row survives — so the
 * dashboard keeps serving a `/api/internal/hermes/media/<id>` URL that 404s.
 *
 * This sweep finds runtime_asset rows whose file is gone from the mount and
 * marks them `orphaned_at = now()`. Two things then happen:
 *   1. queryProductionCreativeAssets filters `orphaned_at IS NULL`, so the
 *      orphaned row stops being surfaced (no more dead URL → no more 404).
 *   2. gc-orphan-uploads.ts reclaims the row after its 24h retention window.
 *
 * SAFETY: only ever touches `storage_kind = 'runtime_asset'`. Composed stories
 * and operator uploads are `ingested_asset` (persisted under DATA_ROOT, never
 * evicted) and are left strictly alone. A row is only marked when the mount is
 * configured AND the file is confirmed missing AND the row is older than the
 * grace window (default 7 days, so a freshly-generated asset that Hermes will
 * still serve is never prematurely orphaned).
 *
 * Default: --dry-run (lists candidates, mutates nothing).
 * --commit applies the orphaned_at marks.
 *
 *   npx tsx scripts/gc-missing-hermes-assets.ts                    # dry run
 *   npx tsx scripts/gc-missing-hermes-assets.ts --commit           # apply
 *   npx tsx scripts/gc-missing-hermes-assets.ts --max-age-days 7 --commit
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_GRACE_DAYS = 7;

// ---------------------------------------------------------------------------
// Worker config parsers (consumed by scripts/automations/gc-missing-hermes-assets-worker.ts).
// Kept here so the sweep module owns both its runner and its config, mirroring
// backend/marketing/draft-expiry-sweep.ts. All accept an explicit env for tests.
// ---------------------------------------------------------------------------

export const DEFAULT_GC_INTERVAL_MS = 21_600_000; // 6h — same cadence as the draft-expiry sweep
export const DEFAULT_GC_MAX_AGE_DAYS = DEFAULT_GRACE_DAYS; // 7

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** ARIES_HERMES_GC_ENABLED — default OFF; the worker idles dormant when false. */
export function gcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env.ARIES_HERMES_GC_ENABLED);
}

/** ARIES_HERMES_GC_DRY_RUN — when true every tick counts + logs but mutates nothing. */
export function gcDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env.ARIES_HERMES_GC_DRY_RUN);
}

/** ARIES_HERMES_GC_INTERVAL_MS — tick interval; non-positive/garbage falls back. */
export function resolveGcIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ARIES_HERMES_GC_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GC_INTERVAL_MS;
}

/** ARIES_HERMES_GC_MAX_AGE_DAYS — grace window; non-positive/garbage falls back. */
export function resolveGcMaxAgeDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ARIES_HERMES_GC_MAX_AGE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GC_MAX_AGE_DAYS;
}

export type GcDb = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type GcMissingOptions = {
  dryRun: boolean;
  db: GcDb;
  mountRoot?: string | null;
  maxAgeDays?: number;
  now?: () => Date;
};

export type GcMissingCandidate = {
  id: string;
  tenantId: string;
  storageKey: string | null;
  resolvedPath: string | null;
  createdAt: string;
};

export type GcMissingStats = {
  scanned: number;
  rowsOrphaned: number;
  fileStillPresent: number;
  tooNew: number;
  errors: number;
  candidates: GcMissingCandidate[];
};

export const SELECT_RUNTIME_ASSETS_SQL = `
  SELECT id, tenant_id, storage_key, created_at
    FROM creative_assets
   WHERE storage_kind = 'runtime_asset'
     AND storage_key IS NOT NULL
     AND orphaned_at IS NULL
   ORDER BY created_at ASC
`;

// Belt-and-suspenders: the WHERE re-asserts runtime_asset + not-already-orphaned
// so a concurrent writer can never let us mark an ingested_asset.
export const MARK_ORPHAN_SQL = `
  UPDATE creative_assets
     SET orphaned_at = $2
   WHERE id = $1
     AND storage_kind = 'runtime_asset'
     AND orphaned_at IS NULL
`;

function logInfo(message: string, fields?: Record<string, unknown>): void {
  process.stdout.write(
    fields
      ? `[gc-missing-hermes-assets] ${message} ${JSON.stringify(fields)}\n`
      : `[gc-missing-hermes-assets] ${message}\n`,
  );
}

function logWarn(message: string, fields?: Record<string, unknown>): void {
  process.stderr.write(
    fields
      ? `[gc-missing-hermes-assets] WARN ${message} ${JSON.stringify(fields)}\n`
      : `[gc-missing-hermes-assets] WARN ${message}\n`,
  );
}

/**
 * Resolve a stored runtime_asset key to the in-container readable path. Mirrors
 * resolveHermesAssetReadPath in ingest-production-assets.ts: the raw host path
 * is unreadable in the container; only `<mount>/<basename>` is.
 */
function resolveMountPath(mountRoot: string, storageKey: string): string {
  return path.resolve(mountRoot, path.basename(storageKey));
}

export async function runGcMissingHermesAssets(options: GcMissingOptions): Promise<GcMissingStats> {
  const stats: GcMissingStats = {
    scanned: 0,
    rowsOrphaned: 0,
    fileStillPresent: 0,
    tooNew: 0,
    errors: 0,
    candidates: [],
  };

  const mountRoot = (options.mountRoot ?? process.env.HERMES_IMAGE_CACHE_MOUNT)?.trim() || null;
  if (!mountRoot) {
    // Without the mount we cannot tell "evicted" from "the script can't see it".
    // Fail safe: do nothing (the media route already 404s + the UI falls back).
    logWarn('HERMES_IMAGE_CACHE_MOUNT not configured; skipping (no rows touched)');
    return stats;
  }

  const maxAgeDays = options.maxAgeDays ?? DEFAULT_GRACE_DAYS;
  const now = options.now ? options.now() : new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

  const result = await options.db.query(SELECT_RUNTIME_ASSETS_SQL);
  const rows = Array.isArray(result.rows) ? result.rows : [];

  for (const entry of rows) {
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? '');
    const tenantId = String(record.tenant_id ?? '');
    const storageKey = typeof record.storage_key === 'string' ? record.storage_key : null;
    const createdAtRaw = record.created_at;
    const createdAt =
      createdAtRaw instanceof Date
        ? createdAtRaw
        : typeof createdAtRaw === 'string'
          ? new Date(createdAtRaw)
          : null;
    if (!id || !storageKey) {
      stats.errors += 1;
      logWarn('row missing id or storage_key; skipping', { id });
      continue;
    }
    stats.scanned += 1;

    const resolvedPath = resolveMountPath(mountRoot, storageKey);
    if (existsSync(resolvedPath)) {
      stats.fileStillPresent += 1;
      continue;
    }
    // File is missing. Respect the grace window so we never orphan an asset that
    // Hermes may still be writing / will regenerate on a retry.
    if (createdAt && createdAt.getTime() > cutoff.getTime()) {
      stats.tooNew += 1;
      continue;
    }

    const candidate: GcMissingCandidate = { id, tenantId, storageKey, resolvedPath, createdAt: createdAt?.toISOString() ?? '' };
    stats.candidates.push(candidate);

    if (options.dryRun) {
      logInfo('would mark orphaned (file missing from mount)', candidate);
      continue;
    }

    try {
      const update = await options.db.query(MARK_ORPHAN_SQL, [id, now.toISOString()]);
      if ((update.rowCount ?? 0) > 0) {
        stats.rowsOrphaned += 1;
        logInfo('marked orphaned', candidate);
      }
    } catch (err) {
      stats.errors += 1;
      logWarn('mark orphaned failed', { id, error: (err as Error)?.message });
    }
  }

  logInfo('summary', {
    dryRun: options.dryRun,
    mountRoot,
    maxAgeDays,
    cutoff: cutoff.toISOString(),
    scanned: stats.scanned,
    rowsOrphaned: stats.rowsOrphaned,
    fileStillPresent: stats.fileStillPresent,
    tooNew: stats.tooNew,
    errors: stats.errors,
  });

  return stats;
}

function parseMaxAgeDays(argv: string[]): number {
  const flagIdx = argv.indexOf('--max-age-days');
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    const parsed = Number(argv[flagIdx + 1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_GRACE_DAYS;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry.endsWith('gc-missing-hermes-assets.ts') || entry.endsWith('gc-missing-hermes-assets.js');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void (async () => {
    const dryRun = !process.argv.includes('--commit');
    const maxAgeDays = parseMaxAgeDays(process.argv);
    const { pool } = await import('@/lib/db');
    try {
      await runGcMissingHermesAssets({ dryRun, db: pool, maxAgeDays });
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
