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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  applyBrandFrame,
  type BrandKitFrameInput,
  type LogoLoader,
} from '@/backend/creative-memory/frame-overlay';
import { isFeedLogoCompositeEnabled } from '@/backend/social-content/feed-logo-composite-env';
import { resolveDataPath } from '@/lib/runtime-paths';

import type { SocialContentJobRuntimeDocument } from './runtime-state';

export interface IngestProductionAssetsArgs {
  jobId: string;
  tenantId: number;
  doc: SocialContentJobRuntimeDocument;
  pool: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }> };
  /**
   * When set AND ARIES_FEED_LOGO_COMPOSITE_ENABLED is on, the real brand logo is
   * composited onto eligible single-image feed creatives at ingest (frame-overlay
   * border-off + conditional scrim). `logo_file_path` is used as the logo source.
   * Absent/null = no framing (byte-identical legacy behavior).
   */
  brandKit?: (BrandKitFrameInput & { logo_file_path?: string | null }) | null;
  /** Test seam: inject the logo loader so framing tests stay offline. */
  logoLoader?: LogoLoader;
}

export interface IngestProductionAssetsResult {
  inserted: number;
  skipped: number;
  total: number;
}

/**
 * Read the onboarding variant-board grouping tags off the job doc. They are
 * stamped at job-creation time into doc.inputs.request (variant_batch_id +
 * variant_index) by startFirstPostVariantBatch — NOT carried on the Hermes
 * callback (the callback payload has no callback_context). Returns nulls unless
 * BOTH a non-empty batch id and a valid non-negative integer index are present
 * (a half-set pair is treated as untagged so a normal weekly post stays NULL).
 */
export function readVariantTagsFromDoc(
  doc: SocialContentJobRuntimeDocument,
): { variantBatchId: string | null; variantIndex: number | null } {
  const request = doc.inputs?.request as Record<string, unknown> | undefined;
  if (!request || typeof request !== 'object') {
    return { variantBatchId: null, variantIndex: null };
  }
  const rawBatch = request.variant_batch_id ?? request.variantBatchId;
  const variantBatchId = typeof rawBatch === 'string' && rawBatch.trim() ? rawBatch.trim() : null;

  const rawIndex = request.variant_index ?? request.variantIndex;
  let variantIndex: number | null = null;
  if (typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0) {
    variantIndex = rawIndex;
  } else if (typeof rawIndex === 'string' && /^\d+$/.test(rawIndex.trim())) {
    variantIndex = Number.parseInt(rawIndex.trim(), 10);
  }

  if (variantBatchId === null || variantIndex === null) {
    return { variantBatchId: null, variantIndex: null };
  }
  return { variantBatchId, variantIndex };
}

/**
 * True for an onboarding variant-board generation job that has NOT yet been
 * promoted by a pick. These jobs are candidates on the board, not final posts —
 * they must NOT auto-publish to Meta even when ARIES_AUTO_APPROVE_MARKETING_PIPELINE
 * is on. The pick endpoint (Phase 3) sets doc.inputs.request.variant_pick_finalized
 * on the chosen job to release it to publish; the unchosen ones stay held.
 * A normal (non-variant) weekly job has no variant_batch_id → returns false →
 * unchanged behavior.
 */
export function isVariantBoardJobAwaitingPick(doc: SocialContentJobRuntimeDocument): boolean {
  const { variantBatchId } = readVariantTagsFromDoc(doc);
  if (!variantBatchId) return false;
  const request = doc.inputs?.request as Record<string, unknown> | undefined;
  return request?.variant_pick_finalized !== true;
}

type CreativeAssetEntry = {
  assetId: string;
  type: string;
  path?: string;
  prompt?: string;
  placement?: string;
  media_type?: string;
  surface?: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  mime?: string;
  [key: string]: unknown;
};

// Logo compositing applies only to single-image FEED creatives. Treat absent
// type/placement as feed/image (the synthesize-publish-posts default), and
// exclude video and story/reel/carousel placements.
function isFrameEligibleEntry(asset: CreativeAssetEntry): boolean {
  const type = typeof asset.type === 'string' ? asset.type.trim().toLowerCase() : '';
  const mediaType = typeof asset.media_type === 'string' ? asset.media_type.trim().toLowerCase() : '';
  // Never composite a logo onto video (the new contract emits type
  // 'generated_video' / media_type 'video'; legacy emitted type 'video').
  if (type === 'video' || type === 'generated_video' || mediaType === 'video') return false;
  const placement = typeof asset.placement === 'string' ? asset.placement.trim().toLowerCase() : '';
  return placement === '' || placement === 'feed';
}

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
//
// served_asset_ref is id-based (`/api/internal/hermes/media/<id>`) so the media
// route can address bytes by the authoritative PK and enforce ownership in SQL
// (WHERE id=$1 AND tenant_id=$2) instead of a collision-prone shared-cache
// basename match.
//
// served_asset_ref must embed the row's own id. A data-modifying CTE
// (`WITH ins AS (INSERT ... RETURNING id) UPDATE ... FROM ins WHERE id=ins.id`)
// does NOT work: PostgreSQL evaluates the outer UPDATE against a snapshot taken
// before the CTE's INSERT, so it matches 0 rows and served_asset_ref stays NULL
// — the regression PR #517 (commit 6786955) shipped, which silently left every
// new runtime_asset unservable and broke Instagram publishing (IG hard-requires
// a media URL; resolveMediaUrls skips null-ref rows). Verified on the prod DB.
// Instead, generate the uuid in a subselect and use it for BOTH `id` and
// `served_asset_ref` in a single INSERT…SELECT — atomic, self-referential, one
// round-trip (no fan-out, guardrail #1). On checksum conflict the INSERT yields
// 0 rows and the existing row keeps its ref — replay stays idempotent. The
// partial unique index (WHERE checksum IS NOT NULL) is named so null-checksum
// rows never collide. This mirrors story-composer.ts's INSERT_COMPOSED_ASSET_SQL.
// Params: $1 tenantId, $2 jobId, $3 sourceAssetId, $4 storageKey, $5 checksum,
// $6 variantBatchId, $7 variantIndex, $8 storageKind,
// $9 mediaType, $10 aspectRatio, $11 widthPx, $12 heightPx, $13 durationSeconds
const INSERT_PRODUCTION_ASSET_SQL = `
  INSERT INTO creative_assets (
    id, tenant_id, source_type, source_job_id, source_asset_id,
    storage_kind, storage_key, media_type,
    aspect_ratio, checksum, permission_scope,
    learning_lifecycle, usable_for_generation,
    variant_batch_id, variant_index, served_asset_ref,
    width_px, height_px, duration_seconds
  )
  SELECT
    g.id, $1, 'generated_by_aries', $2, $3,
    $8, $4, $9,
    $10, $5, 'generated',
    'observed', false,
    $6, $7, '/api/internal/hermes/media/' || g.id::text,
    $11, $12, $13
  FROM (SELECT gen_random_uuid() AS id) g
  ON CONFLICT (tenant_id, checksum) WHERE checksum IS NOT NULL DO NOTHING
  RETURNING id
`;

// When framing replaces an asset, drop any pre-existing RAW row for the same
// (tenant, job, source_asset_id). Without this, flipping the composite flag ON
// for a job already ingested while OFF would leave a raw + framed twin — and
// synthesize-publish-posts maps rows by index order, so a twin mis-aligns every
// post. Idempotent: once only the framed row remains, it deletes nothing.
const DELETE_RAW_TWIN_SQL = `
  DELETE FROM creative_assets
   WHERE tenant_id = $1
     AND source_job_id = $2
     AND source_asset_id = $3
     AND source_type = 'generated_by_aries'
     AND storage_kind = 'runtime_asset'
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

  // Variant grouping tags are batch-level (same for every asset this job
  // produced); read once from the doc, not per asset.
  const { variantBatchId, variantIndex } = readVariantTagsFromDoc(doc);

  // Read the composite flag once; framing only runs when ON and a brand kit
  // with a materialized logo is available.
  const compositeEnabled = isFeedLogoCompositeEnabled() && Boolean(args.brandKit);

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
      const rawBytes = await readFile(readPath);

      // Logo composite: frame eligible single-image feed creatives, then REPLACE
      // the row's bytes/storage with the framed copy (one row, not a twin — the
      // raw never lands, so synthesize-publish-posts maps the framed asset).
      let bytes: Buffer = rawBytes;
      let storageKind = 'runtime_asset';
      let storageKey = readPath;
      if (compositeEnabled && args.brandKit && isFrameEligibleEntry(asset)) {
        try {
          const framed = await applyBrandFrame({
            assetBuffer: rawBytes,
            brandKit: args.brandKit,
            channel: 'instagram',
            postType: 'single_image',
            border: false,
            logoSource: args.brandKit.logo_file_path ?? null,
            logoLoader: args.logoLoader,
          });
          if (framed !== rawBytes && framed.length > 0) {
            bytes = framed;
            // Framed bytes no longer live at the read-only Hermes mount; persist
            // under DATA_ROOT and repoint storage so the id media route serves
            // the framed copy (mirrors persistComposedStoryAsset's scheme).
            const sha = crypto.createHash('sha256').update(framed).digest('hex');
            // Resolve through the shared data-root helper so the framed-bytes
            // writer and the id media route (which reads via the same resolver)
            // can never diverge, even when DATA_ROOT is unset.
            storageKey = resolveDataPath(
              'ingested-assets',
              String(tenantId),
              sha.slice(0, 2),
              `${sha}.png`,
            );
            await mkdir(path.dirname(storageKey), { recursive: true });
            await writeFile(storageKey, framed);
            storageKind = 'ingested_asset';
          }
        } catch (frameError) {
          // Never block ingest on framing — fall back to the raw bytes/mount.
          console.warn('[ingest-production-assets] logo composite failed — using raw bytes', {
            jobId,
            tenantId,
            error: (frameError as Error)?.message,
          });
        }
      }

      // Checksum the FINAL bytes (framed when framed) so the (tenant_id, checksum)
      // idempotency key matches what is stored.
      const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
      // source_asset_id stays Hermes-keyed even when framed — synthesize-publish-
      // posts orders posts by source_asset_id, so it must track the original asset.
      const basename = path.basename(readPath);
      const sourceAssetId = typeof asset.assetId === 'string' && asset.assetId.trim()
        ? asset.assetId.trim()
        : basename;

      // Derive media type: 'video' when the entry carries video markers.
      const isVideo =
        asset.type === 'generated_video' ||
        (typeof asset.media_type === 'string' && asset.media_type.trim().toLowerCase() === 'video');
      const mediaType: 'image' | 'video' = isVideo ? 'video' : 'image';

      // Derive aspect ratio from width/height when present; else from surface/placement.
      const entryWidth = typeof asset.width === 'number' && Number.isFinite(asset.width) ? asset.width : null;
      const entryHeight = typeof asset.height === 'number' && Number.isFinite(asset.height) ? asset.height : null;
      const entryDuration =
        typeof asset.duration_seconds === 'number' && Number.isFinite(asset.duration_seconds)
          ? asset.duration_seconds
          : null;

      let aspectRatio: string;
      if (entryWidth !== null && entryHeight !== null && entryWidth > 0 && entryHeight > 0) {
        // Reduce to a simplified ratio string; map to nearest known where reasonable.
        if (entryHeight > entryWidth) {
          aspectRatio = '9:16';
        } else {
          aspectRatio = '4:5';
        }
      } else {
        // Infer from surface / placement.
        const surface = typeof asset.surface === 'string' ? asset.surface.trim().toLowerCase() : '';
        const placement = typeof asset.placement === 'string' ? asset.placement.trim().toLowerCase() : '';
        const isVertical = surface === 'reel' || surface === 'story' || placement === 'reel' || placement === 'story';
        aspectRatio = isVertical ? '9:16' : '4:5';
      }

      // served_asset_ref is built inside the INSERT from the row's own (subselect-
      // generated) id, so it is not passed as a parameter here.
      const result = await pool.query(INSERT_PRODUCTION_ASSET_SQL, [
        tenantId,      // $1
        jobId,         // $2
        sourceAssetId, // $3
        storageKey,    // $4
        checksum,      // $5
        variantBatchId, // $6
        variantIndex,  // $7
        storageKind,   // $8
        mediaType,     // $9
        aspectRatio,   // $10
        entryWidth,    // $11
        entryHeight,   // $12
        entryDuration, // $13
      ]);

      const rowCount = result.rowCount ?? 0;
      if (rowCount > 0) {
        inserted++;
      } else {
        skipped++;
      }

      // The framed row now exists (just inserted or already present via ON
      // CONFLICT); remove any stale raw twin so post->image mapping stays
      // one-row-per-asset across an OFF->ON flag flip.
      if (storageKind === 'ingested_asset') {
        await pool.query(DELETE_RAW_TWIN_SQL, [tenantId, jobId, sourceAssetId]);
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
