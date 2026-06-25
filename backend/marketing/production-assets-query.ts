/**
 * Job-scoped query for DB-persisted production creative assets.
 *
 * Moved from workspace-views.ts to a neutral module so it can be imported by
 * BOTH workspace-views.ts and dashboard-content.ts without creating a circular
 * dependency (workspace-views.ts already imports from dashboard-content.ts).
 *
 * Query contract: returns `creative_assets` rows for a job where
 *   source_type = 'generated_by_aries' AND orphaned_at IS NULL
 * ordered by creation time (oldest first). The `served_asset_ref` column holds
 * `/api/internal/hermes/media/<uuid>` — the browser-safe preview URL emitted by
 * `ingest-production-assets.ts`.
 */

import { pool } from '@/lib/db';

export const SELECT_PRODUCTION_CREATIVE_ASSETS_SQL = `
  SELECT id, source_asset_id, served_asset_ref, checksum,
         media_type, aspect_ratio, width_px, height_px, duration_seconds
    FROM creative_assets
   WHERE tenant_id = $1
     AND source_job_id = $2
     AND source_type = 'generated_by_aries'
     AND orphaned_at IS NULL
   ORDER BY created_at ASC
`;

export type ProductionCreativeAssetRow = {
  id: string;
  source_asset_id: string | null;
  served_asset_ref: string | null;
  checksum: string | null;
  media_type: string | null;
  aspect_ratio: string | null;
  width_px: number | null;
  height_px: number | null;
  duration_seconds: number | null;
};

export async function queryProductionCreativeAssets(
  tenantId: string,
  jobId: string,
): Promise<ProductionCreativeAssetRow[]> {
  const tenantNum = Number(tenantId);
  if (!Number.isFinite(tenantNum) || tenantNum <= 0) return [];
  try {
    const result = await pool.query(SELECT_PRODUCTION_CREATIVE_ASSETS_SQL, [tenantNum, jobId]);
    return (result.rows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id ?? ''),
        source_asset_id: typeof r.source_asset_id === 'string' ? r.source_asset_id : null,
        served_asset_ref: typeof r.served_asset_ref === 'string' ? r.served_asset_ref : null,
        checksum: typeof r.checksum === 'string' ? r.checksum : null,
        media_type: typeof r.media_type === 'string' ? r.media_type : null,
        aspect_ratio: typeof r.aspect_ratio === 'string' ? r.aspect_ratio : null,
        width_px: typeof r.width_px === 'number' && Number.isFinite(r.width_px) ? r.width_px : null,
        height_px: typeof r.height_px === 'number' && Number.isFinite(r.height_px) ? r.height_px : null,
        duration_seconds:
          typeof r.duration_seconds === 'number' && Number.isFinite(r.duration_seconds)
            ? r.duration_seconds
            : null,
      };
    });
  } catch (err) {
    console.warn('[production-assets-query] queryProductionCreativeAssets failed', {
      jobId,
      error: (err as Error)?.message ?? String(err),
    });
    return [];
  }
}
