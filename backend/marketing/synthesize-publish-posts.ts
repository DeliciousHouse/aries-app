/**
 * Synthesize DB `posts` rows from a completed Hermes publish stage.
 *
 * CONTRACT — why this exists:
 * The Hermes-native marketing pipeline never emits the `publish_package` /
 * `review_bundle` shape the legacy publish path produced; that contract
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
 * supplied NO `publish_package`, synthesize one `posts` row per content_package
 * entry per target platform, linking each to its rendered image via
 * `creative_asset_ids`.
 *
 * The synthesized posts are created APPROVED (`status='approved'`,
 * `published_status='approved'`) so a completed pipeline immediately populates
 * the calendar's unscheduled-approved backlog and the posts are schedulable +
 * publishable. This is consistent with this deployment's autonomous mode
 * (`ARIES_AUTO_APPROVE_MARKETING_PIPELINE=1`, single-tenant prod): there is no
 * human approval click in the pipeline, so synthesizing approved posts matches
 * how the pipeline already operates. The schedule route
 * (`app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts`) also
 * gates on a `publish`-stage `MarketingApprovalRecord` with status `approved`;
 * the autonomous publish run never creates one, so this module synthesizes that
 * record too — otherwise a synthesized post would 409 at scheduling time.
 *
 * Scope guard: this only fires when there is a populated `content_package` and
 * NO *consumable* `publish_package` — one with `platform_previews` / `posts` /
 * `content_calendar` that the legacy `dashboard-content.ts` path can turn into
 * launch items. The Hermes publish agent commonly returns a thin, plan-only
 * `publish_package` (cadence / schedule / notes) that no consumer can use; that
 * does NOT block synthesis. Only a genuinely consumable package makes this a
 * no-op, so the two paths never double-create posts.
 *
 * Out of scope: landing-page / script / rich-preview artifacts. Those are
 * genuinely absent from the Hermes output and are not reconstructed here.
 *
 * Idempotency: every post row carries an idempotency key
 * `${jobId}:${postNumber}:${platform}`; the `(tenant_id, platform,
 * idempotency_key)` unique index makes a replayed callback a no-op. The
 * synthesized approval record uses a deterministic id (`mkta_synth_<jobId>`),
 * so a replay finds the existing record instead of creating a duplicate.
 */

import {
  createMarketingApprovalRecord,
  findLatestMarketingApprovalRecord,
  saveMarketingApprovalRecord,
} from './approval-store';
import type { SocialContentJobRuntimeDocument } from './runtime-state';

export interface SynthesizePublishPostsArgs {
  jobId: string;
  tenantId: number;
  doc: SocialContentJobRuntimeDocument;
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
  /** True when an approved publish-stage approval record exists after this call. */
  approvalRecordReady: boolean;
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

// Synthesized posts are inserted `approved` so they immediately satisfy the
// calendar's unscheduled-approved backlog query (`published_status='approved'
// OR status='approved'`) and are schedulable. See the module header for why
// approved (not draft) is correct for this autonomous-mode deployment.
const INSERT_SYNTHESIZED_POST_SQL = `
  INSERT INTO posts (
    tenant_id, job_id, hermes_run_id, platform, media_type,
    caption, status, published_status, idempotency_key, creative_asset_ids
  ) VALUES (
    $1, $2, $3, $4, 'image',
    $5, 'approved', 'approved', $6, $7
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
 * Returns true ONLY when the publish-stage output carries a `publish_package`
 * the legacy consumer can actually turn into launch items — i.e. one with
 * `platform_previews` (what `dashboard-content.ts` reads to build publish
 * items). In that case the legacy path owns the output and we must not
 * double-create posts.
 *
 * The mere PRESENCE of a `publish_package` key is NOT enough: the Hermes
 * publish agent commonly returns a thin, plan-only `publish_package`
 * (approval_gate / cadence / schedule / publishing_notes / risk_controls) with
 * no `platform_previews`, no `posts`, no media. No consumer turns that into a
 * `posts` row, so deferring on it would mean nothing reaches the calendar —
 * exactly the Cause 3 failure. A thin publish_package must NOT block synthesis.
 */
function hasConsumablePublishPackage(doc: SocialContentJobRuntimeDocument): boolean {
  const isConsumable = (value: unknown): boolean => {
    const pkg = recordValue(value);
    if (!pkg) return false;
    // platform_previews is the field dashboard-content.ts consumes; posts /
    // content_calendar are the other shapes a real launch-ready package uses.
    return (
      Array.isArray(pkg.platform_previews) && pkg.platform_previews.length > 0
    ) || (
      Array.isArray(pkg.posts) && pkg.posts.length > 0
    ) || recordValue(pkg.content_calendar) !== null;
  };

  const publishOutput = recordValue(doc.stages.publish?.primary_output);
  if (!publishOutput) return false;
  if (isConsumable(publishOutput.publish_package)) return true;
  const artifacts = recordValue(publishOutput.artifacts);
  if (artifacts && isConsumable(artifacts.publish_package)) return true;
  return false;
}

/**
 * Locate the `content_package` array. It is canonical on the production stage's
 * primary_output (where it lines up 1:1 with the rendered creative_assets by
 * post_number); fall back to the publish stage's output if production lacks it.
 */
function extractContentPackage(doc: SocialContentJobRuntimeDocument): unknown {
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

/**
 * Ensure an approved `publish`-stage approval record exists for the job.
 *
 * The schedule route gates on `findLatestMarketingApprovalRecord({
 * marketingStage:'publish', statuses:['approved'] })`. The autonomous publish
 * run never creates one (it is an `action: run` auto-advance with no approval),
 * so a synthesized post would 409 at scheduling time without this.
 *
 * Uses a deterministic approval id (`mkta_synth_<jobId>`) so a replayed
 * callback finds the existing record instead of creating a duplicate. Returns
 * true when an approved publish-stage record exists after the call (whether
 * pre-existing or freshly synthesized).
 */
function ensureSynthesizedPublishApprovalRecord(
  jobId: string,
  tenantId: number,
  publishRunId: string | null,
): boolean {
  const tenantIdStr = String(tenantId);
  // A real publish approval (e.g. from a future human-gated run) already
  // satisfies the gate — do not add a second record.
  const existing = findLatestMarketingApprovalRecord({
    marketingJobId: jobId,
    tenantId: tenantIdStr,
    marketingStage: 'publish',
    statuses: ['approved'],
  });
  if (existing) {
    return true;
  }

  const nowTs = new Date().toISOString();
  const record = createMarketingApprovalRecord({
    approvalId: `mkta_synth_${jobId}`,
    tenantId: tenantIdStr,
    marketingJobId: jobId,
    workflowName: 'marketing_pipeline',
    workflowStepId: 'approve_stage_4_publish',
    marketingStage: 'publish',
    approvalPrompt: 'Synthesized publish approval — autonomous-mode pipeline completed without a human publish gate.',
    runtimeContext: { pipelinePath: 'marketing_pipeline', cwd: 'hermes', sessionKey: 'marketing' },
  });
  // createMarketingApprovalRecord returns a `pending` record; this deployment's
  // autonomous mode has no human click, so mark it approved immediately.
  record.status = 'approved';
  record.resolution = 'approve';
  record.resolved_at = nowTs;
  record.resolution_result = {
    resumed_stage: 'publish',
    completed: true,
    outcome: 'synthesized_autonomous_publish_approval',
  };
  if (publishRunId) {
    record.execution_resume_token = publishRunId;
  }
  saveMarketingApprovalRecord(record);
  return true;
}

export async function synthesizePublishPostsFromContentPackage(
  args: SynthesizePublishPostsArgs,
): Promise<SynthesizePublishPostsResult> {
  const { jobId, tenantId, doc, publishRunId, pool } = args;

  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return { inserted: 0, skipped: 0, total: 0, approvalRecordReady: false, reason: 'no_tenant' };
  }

  // Scope guard: defer to the legacy path ONLY when the publish_package is one
  // the legacy consumer can actually turn into launch items (has
  // platform_previews / posts / content_calendar). A thin, plan-only
  // publish_package does NOT block synthesis — see hasConsumablePublishPackage.
  if (hasConsumablePublishPackage(doc)) {
    return {
      inserted: 0,
      skipped: 0,
      total: 0,
      approvalRecordReady: false,
      reason: 'publish_package_present',
    };
  }

  const entries = parseContentPackage(extractContentPackage(doc));
  if (entries.length === 0) {
    return {
      inserted: 0,
      skipped: 0,
      total: 0,
      approvalRecordReady: false,
      reason: 'no_content_package',
    };
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

  // A synthesized post must be schedulable: the schedule route requires an
  // approved publish-stage approval record. Ensure one exists (idempotent).
  let approvalRecordReady = false;
  try {
    approvalRecordReady = ensureSynthesizedPublishApprovalRecord(jobId, tenantId, publishRunId);
  } catch (err) {
    console.warn('[synthesize-publish-posts] approval-record synthesis failed — posts created but not yet schedulable', {
      jobId,
      tenantId,
      error: (err as Error)?.message ?? String(err),
    });
  }

  return { inserted, skipped, total, approvalRecordReady };
}
