/**
 * Ingest production-stage creative_assets from the Hermes runtime document
 * into the `creative_assets` DB table so publish handlers and workspace views
 * can find approved creatives without re-scanning the filesystem.
 *
 * Called from the production-completed branch of hermes-callbacks.ts.
 * Idempotent: ON CONFLICT (tenant_id, checksum) DO NOTHING means re-running
 * on a duplicate callback is safe.
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { MarketingJobRuntimeDocument } from './runtime-state';

export interface IngestProductionAssetsArgs {
  jobId: string;
  tenantId: number;
  doc: MarketingJobRuntimeDocument;
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
  ON CONFLICT (tenant_id, checksum) DO NOTHING
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

    try {
      const bytes = await readFile(assetPath);
      const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
      const basename = path.basename(assetPath);
      const servedAssetRef = `/api/internal/hermes/media/${basename}`;
      const sourceAssetId = typeof asset.assetId === 'string' && asset.assetId.trim()
        ? asset.assetId.trim()
        : basename;

      const result = await pool.query(INSERT_PRODUCTION_ASSET_SQL, [
        tenantId,
        jobId,
        sourceAssetId,
        servedAssetRef,
        assetPath,
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
