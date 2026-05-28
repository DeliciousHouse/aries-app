/**
 * Ingest production-stage creative_assets from the Hermes runtime document
 * into the `creative_assets` DB table so publish handlers and workspace views
 * can find approved creatives without re-scanning the filesystem.
 *
 * Called from the production-completed branch of hermes-callbacks.ts.
 * Idempotent: ON CONFLICT (tenant_id, checksum) WHERE checksum IS NOT NULL
 * DO NOTHING means re-running on a duplicate callback is safe. The WHERE
 * predicate is mandatory — it matches the partial unique index
 * `idx_creative_assets_tenant_checksum_unique`; without it Postgres cannot
 * infer the index and rejects every INSERT.
 *
 * Path resolution: Hermes reports `creative_assets[].path` as a path on the
 * *Hermes host* (e.g. `/home/node/.hermes/profiles/<profile>/cache/images/x.png`).
 * The Aries container cannot read host paths — it can only read the Hermes image
 * cache through the `HERMES_IMAGE_CACHE_MOUNT` bind-mount, keyed by basename.
 * So every read MUST resolve `<mount>/<basename>`, never the raw reported path.
 * Reading the raw path directly silently ENOENTs and ingests zero rows — which
 * is exactly the publish-output regression this resolution fixes.
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { SocialContentJobRuntimeDocument } from './runtime-state';

export interface IngestProductionAssetsArgs {
  jobId: string;
  tenantId: number;
  doc: SocialContentJobRuntimeDocument;
  pool: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }> };
}

export interface IngestProductionAssetsResult {
  inserted: number;
  skipped: number;
  total: number;
}

type CreativeAssetEntry = {
  assetId: string;
  type: string;
  path?: string;
  prompt?: string;
  placement?: string;
  [key: string]: unknown;
};

/**
 * Resolves a Hermes-reported asset path to a path the Aries container can
 * actually read. Hermes paths are host-side and not visible in the container;
 * only `HERMES_IMAGE_CACHE_MOUNT/<basename>` is. Returns null when the mount is
 * unconfigured or the basename is unusable (path traversal / empty).
 */
export function resolveHermesAssetReadPath(reportedPath: string): string | null {
  const mount = process.env.HERMES_IMAGE_CACHE_MOUNT?.trim();
  if (!mount) {
    return null;
  }
  const basename = path.basename(reportedPath.trim());
  if (!basename || basename === '.' || basename === '..' || basename.includes('/') || basename.includes('\\')) {
    return null;
  }
  const mountRoot = path.normalize(mount);
  const candidate = path.resolve(mountRoot, basename);
  const relative = path.relative(mountRoot, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

// ON CONFLICT must name the PARTIAL-index predicate. The matching unique index
// is `idx_creative_assets_tenant_checksum_unique`: UNIQUE (tenant_id, checksum)
// WHERE checksum IS NOT NULL. Postgres only infers a partial unique index when
// the statement repeats its predicate — omitting `WHERE checksum IS NOT NULL`
// makes every INSERT fail with "no unique or exclusion constraint matching the
// ON CONFLICT specification", so a replayed publish callback ingested zero rows.
const INSERT_PRODUCTION_ASSET_SQL = `
  INSERT INTO creative_assets (
    tenant_id, source_type, source_job_id, source_asset_id,
    served_asset_ref, storage_kind, storage_key, media_type,
    aspect_ratio, checksum, permission_scope,
    learning_lifecycle, usable_for_generation
  ) VALUES (
    $1, 'generated_by_aries', $2, $3,
    $4, 'runtime_asset', $5, 'image',
    '4:5', $6, 'generated',
    'observed', false
  )
  ON CONFLICT (tenant_id, checksum) WHERE checksum IS NOT NULL DO NOTHING
`;

export async function ingestProductionCreativeAssetsToDb(
  args: IngestProductionAssetsArgs,
): Promise<IngestProductionAssetsResult> {
  const { jobId, tenantId, doc, pool } = args;

  const primaryOutput = doc.stages.production.primary_output;
  if (!primaryOutput || typeof primaryOutput !== 'object') {
    return { inserted: 0, skipped: 0, total: 0 };
  }

  const artifacts = (primaryOutput as Record<string, unknown>).artifacts;
  if (!artifacts || typeof artifacts !== 'object') {
    return { inserted: 0, skipped: 0, total: 0 };
  }

  const creativeAssets = (artifacts as Record<string, unknown>).creative_assets;
  if (!Array.isArray(creativeAssets) || creativeAssets.length === 0) {
    return { inserted: 0, skipped: 0, total: 0 };
  }

  let inserted = 0;
  let skipped = 0;

  for (const entry of creativeAssets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped++;
      continue;
    }

    const asset = entry as CreativeAssetEntry;
    const assetPath = typeof asset.path === 'string' ? asset.path.trim() : '';
    if (!assetPath) {
      skipped++;
      continue;
    }

    // Hermes reports a host-side path; the container can only read the image
    // through the HERMES_IMAGE_CACHE_MOUNT bind-mount keyed by basename.
    const readPath = resolveHermesAssetReadPath(assetPath);
    if (!readPath) {
      console.warn('[ingest-production-assets] unresolvable asset path — skipping', {
        jobId,
        tenantId,
        assetPath,
        mountConfigured: Boolean(process.env.HERMES_IMAGE_CACHE_MOUNT?.trim()),
      });
      skipped++;
      continue;
    }

    try {
      const bytes = await readFile(readPath);
      const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
      const basename = path.basename(readPath);
      const servedAssetRef = `/api/internal/hermes/media/${basename}`;
      const sourceAssetId = typeof asset.assetId === 'string' && asset.assetId.trim()
        ? asset.assetId.trim()
        : basename;

      const result = await pool.query(INSERT_PRODUCTION_ASSET_SQL, [
        tenantId,
        jobId,
        sourceAssetId,
        servedAssetRef,
        readPath,
        checksum,
      ]);

      const rowCount = result.rowCount ?? 0;
      if (rowCount > 0) {
        inserted++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.warn('[ingest-production-assets] row failed — skipping', {
        jobId,
        tenantId,
        assetPath,
        error: (err as Error)?.message ?? String(err),
      });
      skipped++;
    }
  }

  return { inserted, skipped, total: creativeAssets.length };
}
