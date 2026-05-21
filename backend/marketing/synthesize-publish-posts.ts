/**
 * Synthesize DB `posts` rows from a completed Hermes publish stage.
 *
 * CONTRACT — why this exists:
 * The Hermes-native marketing pipeline never emits the `publish_package` /
 * `review_bundle` shape the legacy OpenClaw publish path produced; that contract
 * is dead on the Hermes path. What Hermes *does* produce reliably is:
 *   - `content_package[]` — per-post copy (hook/body/cta/hashtags/platforms),
 *     carried on the production stage's `primary_output`.
 *   - rendered images, ingested into the `creative_assets` table by
 *     `ingestProductionCreativeAssetsToDb` on the production-completed callback.
 * Neither one becomes a `posts` row on its own, so a completed pipeline left
 * the operator with "Publish items 0 / No launch items" and nothing reachable
 * by the scheduled-posts calendar.
 *
 * This module is the missing link: when the publish stage completes and Hermes
 * supplied NO `publish_package`, synthesize one draft `posts` row per
 * content_package entry per target platform, linking each to its rendered image
 * via `creative_asset_ids`. The operator then approves and schedules those
 * draft posts through the existing approval-gated calendar flow.
 *
 * Scope guard: this only fires when there is a populated `content_package` and
 * NO real `publish_package`. If a `publish_package` is ever present, the legacy
 * consumer path owns it and this is a no-op — no double-creation.
 *
 * Out of scope: landing-page / script / rich-preview artifacts. Those are
 * genuinely absent from the Hermes output and are not reconstructed here.
 *
 * Idempotency: every row carries an idempotency key
 * `${jobId}:${postNumber}:${platform}`; the `(tenant_id, platform,
 * idempotency_key)` unique index makes a replayed callback a no-op.
 */

import type { MarketingJobRuntimeDocument } from './runtime-state';

export interface SynthesizePublishPostsArgs {
  jobId: string;
  tenantId: number;
  doc: MarketingJobRuntimeDocument;
  /** Hermes run id of the publish stage, stored on each synthesized row. */
  publishRunId: string | null;
  pool: {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  };
}

export interface SynthesizePublishPostsResult {
  inserted: number;
  skipped: number;
  /** Total (content_package entry x platform) pairs considered. */
  total: number;
  /** Reason the synthesis did not run, when inserted+skipped+total are all 0. */
  reason?: 'no_content_package' | 'publish_package_present' | 'no_tenant';
}

type ContentPackageEntry = {
  postNumber: number;
  caption: string;
  platforms: string[];
};

const VALID_PLATFORMS = new Set(['instagram', 'facebook']);

const SELECT_CREATIVE_ASSETS_SQL = `
  SELECT id, source_asset_id
    FROM creative_assets
   WHERE tenant_id = $1
     AND source_job_id = $2
     AND source_type = 'generated_by_aries'
   ORDER BY source_asset_id ASC
`;

const INSERT_SYNTHESIZED_POST_SQL = `
  INSERT INTO posts (
    tenant_id, job_id, hermes_run_id, platform, media_type,
    caption, status, published_status, idempotency_key, creative_asset_ids
  ) VALUES (
    $1, $2, $3, $4, 'image',
    $5, 'draft', 'draft', $6, $7
  )
  ON CONFLICT (tenant_id, platform, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
`;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Build a single caption string from a content_package entry. Hermes splits the
 * copy into hook / body / cta / hashtags; the `posts.caption` column is one
 * text field, so join them the way an operator would expect to see the post.
 */
function buildCaption(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  const hook = typeof entry.hook === 'string' ? entry.hook.trim() : '';
  const body = typeof entry.body === 'string' ? entry.body.trim() : '';
  const cta = typeof entry.cta === 'string' ? entry.cta.trim() : '';
  if (hook) parts.push(hook);
  if (body) parts.push(body);
  if (cta) parts.push(cta);
  let caption = parts.join('\n\n');

  const hashtags = Array.isArray(entry.hashtags)
    ? entry.hashtags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    : [];
  if (hashtags.length > 0) {
    caption = caption ? `${caption}\n\n${hashtags.join(' ')}` : hashtags.join(' ');
  }
  return caption;
}

/**
 * Normalize the raw `content_package` array into typed entries. Drops entries
 * with no usable post number or no recognized platform.
 */
function parseContentPackage(raw: unknown): ContentPackageEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: ContentPackageEntry[] = [];
  raw.forEach((item, index) => {
    const record = recordValue(item);
    if (!record) return;
    const rawPostNumber = record.post_number;
    const postNumber =
      typeof rawPostNumber === 'number' && Number.isInteger(rawPostNumber) && rawPostNumber > 0
        ? rawPostNumber
        : index + 1;
    const platforms = Array.isArray(record.platforms)
      ? record.platforms
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim().toLowerCase())
          .filter((p) => VALID_PLATFORMS.has(p))
      : [];
    if (platforms.length === 0) return;
    const caption = buildCaption(record);
    if (!caption) return;
    entries.push({ postNumber, caption, platforms: Array.from(new Set(platforms)) });
  });
  return entries;
}

/**
 * Returns true when the publish-stage output already carries a real
 * `publish_package` — in which case the legacy consumer owns it and we must not
 * synthesize. Checks both the publish primary_output and its `artifacts`.
 */
function hasRealPublishPackage(doc: MarketingJobRuntimeDocument): boolean {
  const publishOutput = recordValue(doc.stages.publish?.primary_output);
  if (!publishOutput) return false;
  if (recordValue(publishOutput.publish_package)) return true;
  const artifacts = recordValue(publishOutput.artifacts);
  if (artifacts && recordValue(artifacts.publish_package)) return true;
  return false;
}

/**
 * Locate the `content_package` array. It is canonical on the production stage's
 * primary_output (where it lines up 1:1 with the rendered creative_assets by
 * post_number); fall back to the publish stage's output if production lacks it.
 */
function extractContentPackage(doc: MarketingJobRuntimeDocument): unknown {
  const productionOutput = recordValue(doc.stages.production?.primary_output);
  if (productionOutput && Array.isArray(productionOutput.content_package)) {
    return productionOutput.content_package;
  }
  const publishOutput = recordValue(doc.stages.publish?.primary_output);
  if (publishOutput && Array.isArray(publishOutput.content_package)) {
    return publishOutput.content_package;
  }
  return null;
}

export async function synthesizePublishPostsFromContentPackage(
  args: SynthesizePublishPostsArgs,
): Promise<SynthesizePublishPostsResult> {
  const { jobId, tenantId, doc, publishRunId, pool } = args;

  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return { inserted: 0, skipped: 0, total: 0, reason: 'no_tenant' };
  }

  // Scope guard: defer to the legacy path when a real publish_package exists.
  if (hasRealPublishPackage(doc)) {
    return { inserted: 0, skipped: 0, total: 0, reason: 'publish_package_present' };
  }

  const entries = parseContentPackage(extractContentPackage(doc));
  if (entries.length === 0) {
    return { inserted: 0, skipped: 0, total: 0, reason: 'no_content_package' };
  }

  // Pull the ingested creative_assets so each post can be linked to its image.
  // post_number N (1-indexed) maps to the Nth creative asset in source_asset_id
  // order — the same ordering ingestProductionCreativeAssetsToDb preserves.
  let assetIdsByPostNumber = new Map<number, string>();
  try {
    const result = await pool.query(SELECT_CREATIVE_ASSETS_SQL, [tenantId, jobId]);
    const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
    assetIdsByPostNumber = new Map(
      rows.map((row, index) => {
        const assetId =
          typeof row.source_asset_id === 'string' && row.source_asset_id.trim()
            ? row.source_asset_id.trim()
            : String(row.id ?? '');
        return [index + 1, assetId] as const;
      }),
    );
  } catch (err) {
    console.warn('[synthesize-publish-posts] creative_assets lookup failed — continuing without media links', {
      jobId,
      tenantId,
      error: (err as Error)?.message ?? String(err),
    });
  }

  let inserted = 0;
  let skipped = 0;
  let total = 0;

  for (const entry of entries) {
    const assetId = assetIdsByPostNumber.get(entry.postNumber);
    const creativeAssetIds = assetId ? [assetId] : [];
    for (const platform of entry.platforms) {
      total++;
      const idempotencyKey = `${jobId}:${entry.postNumber}:${platform}`;
      try {
        const result = await pool.query(INSERT_SYNTHESIZED_POST_SQL, [
          tenantId,
          jobId,
          publishRunId,
          platform,
          entry.caption,
          idempotencyKey,
          creativeAssetIds,
        ]);
        if ((result.rowCount ?? 0) > 0) {
          inserted++;
        } else {
          // ON CONFLICT DO NOTHING — a prior callback already created this row.
          skipped++;
        }
      } catch (err) {
        console.warn('[synthesize-publish-posts] row insert failed — skipping', {
          jobId,
          tenantId,
          platform,
          postNumber: entry.postNumber,
          error: (err as Error)?.message ?? String(err),
        });
        skipped++;
      }
    }
  }

  return { inserted, skipped, total };
}
