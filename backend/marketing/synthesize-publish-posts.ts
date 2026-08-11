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
  CROSSPOST_PLATFORMS,
  isAnyPlatformPublishEnabled,
  isPlatformNativeContentEnabled,
  META_PUBLISH_PLATFORMS,
} from '@/backend/integrations/providers/integration-config';

import {
  createMarketingApprovalRecord,
  findLatestMarketingApprovalRecord,
  saveMarketingApprovalRecord,
} from './approval-store';
import { recordDeliveryComposition } from './delivery-composition';
import { isPostEditTasteLearningEnabled } from './post-edit-taste-learning-env';
import { resolvePrimaryPublishPlatforms } from './primary-publish-platforms';
import type { SocialContentJobRuntimeDocument } from './runtime-state';
import { visualStyleLens } from './taste-profile-store';
import { isWeeklyReelEnabled } from './weekly-reel-env';
import {
  adaptCaptionForPlatform,
  buildVariantCaption,
  isWeeklyCrosspostEnabled,
  resolveCrosspostPlatforms,
  type CrosspostPlatform,
  type PlatformVariantCopy,
} from './weekly-crosspost';

export interface SynthesizePublishPostsArgs {
  jobId: string;
  tenantId: number;
  doc: SocialContentJobRuntimeDocument;
  /** Hermes run id of the publish stage, stored on each synthesized row. */
  publishRunId: string | null;
  pool: {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  };
  /**
   * Optional story-image composer. When provided, a promoted story post is
   * backed by a COMPOSED 9:16 image (headline + brand CTA baked in) instead of
   * the bare feed creative — because Meta story publishing renders only pixels
   * (no caption, no link sticker). Returns the composed creative_asset id, or
   * null to fall back to the raw creative. Omitted in unit tests (pure) and
   * wired to `composeStoryAssetForBaseCreative` in production (hermes-callbacks).
   */
  composeStoryAsset?: (args: {
    tenantId: number;
    jobId: string;
    baseAssetId: string;
    headline: string;
  }) => Promise<string | null>;
}

export interface SynthesizePublishPostsResult {
  inserted: number;
  skipped: number;
  /** Total (content_package entry x platform) pairs considered. */
  total: number;
  /** True when an approved publish-stage approval record exists after this call. */
  approvalRecordReady: boolean;
  /**
   * Video/reel (post, platform) targets that were DROPPED because the job has
   * no ingested video creative_asset. A reel with no video can never publish —
   * synthesizing it anyway produced dead posts 415/416 (2026-07-13) that failed
   * dispatch terminally. These drops also count into `skipped`.
   */
  droppedVideoNoAsset: number;
  /** Reason the synthesis did not run, when inserted+skipped+total are all 0. */
  reason?:
    | 'no_content_package'
    | 'publish_package_present'
    | 'no_tenant'
    | 'no_connected_platform';
}

type ContentPackageEntry = {
  postNumber: number;
  caption: string;
  /** The post hook — used as the story headline when composing story images. */
  headline: string;
  /** Cleaned hashtag tokens — used to compose the X crosspost caption. */
  hashtags: string[];
  platforms: string[];
  /**
   * AA-217 v2: NATIVE per-platform copy the strategist wrote for this post
   * (`content_package[].platform_variants`). Only populated when the
   * platform-native flag is on for the tenant. Always OPTIONAL at the point of
   * use — Hermes is non-deterministic, so a missing or partial variant must
   * degrade to `adaptCaptionForPlatform`, never drop the post.
   */
  platformVariants?: Partial<Record<CrosspostPlatform, PlatformVariantCopy>>;
};

const VALID_PLATFORMS = new Set<string>(META_PUBLISH_PLATFORMS);

/**
 * The Meta-family platforms the MAIN insert loop is allowed to write. Identical
 * to VALID_PLATFORMS today; named separately because the two express different
 * rules and only one of them widens under the platform-native flag.
 */
const META_PLATFORM_SET = new Set<string>(META_PUBLISH_PLATFORMS);

/**
 * The platform set `parseContentPackage` accepts when platform-native content is
 * enabled for the tenant. THIS MUST LAND WITH THE PROMPT CHANGES, never after:
 * teaching the strategist to emit `platforms:["linkedin"]` while the parser
 * still drops non-Meta entries produces an EMPTY WEEK, silently.
 */
const NATIVE_VALID_PLATFORMS = new Set<string>([...META_PUBLISH_PLATFORMS, ...CROSSPOST_PLATFORMS]);

type PostSurface = 'feed' | 'story' | 'reel';
type PostMediaType = 'image' | 'video';

/** A per-(postNumber, platform) publish shape resolved from the weekly schedule. */
type ScheduleShape = { surface: PostSurface; mediaType: PostMediaType };

/**
 * Rollout gate. When OFF (default), video/reel entries are stripped at
 * synthesis so the campaign still succeeds on image/feed. Treat 1/true/yes/on
 * as enabled, matching the ARIES_SOCIAL_COPY_FINALIZE_ENABLED convention.
 */
function isVideoPublishEnabled(): boolean {
  const raw = (process.env.ARIES_VIDEO_PUBLISH_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function normalizeSurface(value: unknown): PostSurface {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return v === 'story' || v === 'reel' ? v : 'feed';
}

function normalizeMediaType(value: unknown): PostMediaType {
  return typeof value === 'string' && value.trim().toLowerCase() === 'video' ? 'video' : 'image';
}

/**
 * Read the strategist's weekly schedule from the publish stage and build a
 * lookup of (post_number, platform) -> { surface, media_type }. Mirrors
 * readWeeklySchedule()/the schedule loop in hermes-callbacks.ts, kept local to
 * avoid a circular import (hermes-callbacks imports this module).
 *
 * A reel entry with no media_type is a contract violation (a reel is always
 * video): we coerce it to video and let the validator/gate decide, rather than
 * silently posting an image reel.
 */
function buildScheduleShapeLookup(doc: SocialContentJobRuntimeDocument): Map<string, ScheduleShape> {
  const lookup = new Map<string, ScheduleShape>();

  const setShape = (ordinal: number, platformRaw: unknown, surface: PostSurface, mediaType: PostMediaType) => {
    const platform = String(platformRaw ?? '').trim().toLowerCase();
    if (!platform) return;
    // A reel is always video; never persist an image reel.
    const effectiveMediaType = surface === 'reel' ? 'video' : mediaType;
    lookup.set(`${ordinal}:${platform}`, { surface, mediaType: effectiveMediaType });
  };

  // 1. Primary source: the strategist/publish-stage weekly schedule.
  const primary = recordValue(doc.stages?.publish?.primary_output);
  const rawSchedule =
    primary && Array.isArray((primary as { schedule?: unknown }).schedule)
      ? (primary as { schedule?: unknown[] }).schedule
      : primary && Array.isArray((primary as { weekly_schedule?: unknown }).weekly_schedule)
        ? (primary as { weekly_schedule?: unknown[] }).weekly_schedule
        : null;
  if (Array.isArray(rawSchedule)) {
    rawSchedule.forEach((rawEntry, idx) => {
      const entry = recordValue(rawEntry);
      if (!entry) return;
      const ordinal =
        typeof entry.post_number === 'number' && Number.isInteger(entry.post_number) && entry.post_number > 0
          ? entry.post_number
          : idx + 1;
      const entrySurface = normalizeSurface(entry.placement);
      const entryMediaType = normalizeMediaType(entry.media_type);
      if (Array.isArray(entry.platforms) && entry.platforms.length > 0) {
        for (const platformRaw of entry.platforms) setShape(ordinal, platformRaw, entrySurface, entryMediaType);
      } else if (Array.isArray(entry.platform_targets)) {
        for (const targetRaw of entry.platform_targets) {
          const target = recordValue(targetRaw);
          if (!target) continue;
          setShape(
            ordinal,
            target.platform,
            normalizeSurface(target.placement ?? entry.placement),
            normalizeMediaType(target.media_type ?? entry.media_type),
          );
        }
      }
    });
  }

  // 2. Fallback: when the separate publish stage emits no schedule (the
  //    publish-stage regression), honor a reel/story/video shape that the
  //    production skills (`social-video-creative`) stamped directly on the
  //    content_package entry, for any (post, platform) the publish schedule did
  //    NOT already shape. Only the special non-feed-image surfaces are folded in
  //    — plain feed/image entries keep the existing default feed/image path, so
  //    image-only jobs are byte-identical. The call-site flag gate still strips
  //    reel/video when ARIES_VIDEO_PUBLISH_ENABLED is off.
  const contentPackage = extractContentPackage(doc);
  if (Array.isArray(contentPackage)) {
    contentPackage.forEach((rawEntry, idx) => {
      const entry = recordValue(rawEntry);
      if (!entry) return;
      const surface = normalizeSurface(entry.placement);
      const mediaType = normalizeMediaType(entry.media_type);
      if (surface === 'feed' && mediaType !== 'video') return; // default path already covers feed images
      const ordinal =
        typeof entry.post_number === 'number' && Number.isInteger(entry.post_number) && entry.post_number > 0
          ? entry.post_number
          : idx + 1;
      if (Array.isArray(entry.platforms)) {
        for (const platformRaw of entry.platforms) {
          const platform = String(platformRaw ?? '').trim().toLowerCase();
          if (!platform || lookup.has(`${ordinal}:${platform}`)) continue; // publish schedule wins
          setShape(ordinal, platform, surface, mediaType);
        }
      }
    });
  }

  return lookup;
}

/**
 * The number of image-story posts the weekly run requested (`scope.story_count`,
 * mirrored as `storyCount`/`storiesCount` on the persisted request). Default 0
 * (OFF). Stories are never natively scheduled on Meta, so a requested story is
 * synthesized as an additional `surface='story'` post that publishes live via
 * the scheduled-dispatch path. Reads defensively from the persisted request blob.
 */
function readRequestedStoryCount(doc: SocialContentJobRuntimeDocument): number {
  const request = recordValue((doc as { inputs?: { request?: unknown } }).inputs?.request);
  if (!request) return 0;
  const scope = recordValue(request.scope);
  const raw = request.storyCount ?? request.storiesCount ?? scope?.story_count;
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim().length > 0
        ? Number.parseInt(raw, 10)
        : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

const SELECT_CREATIVE_ASSETS_SQL = `
  SELECT id, source_asset_id, media_type, width_px, height_px, duration_seconds
    FROM creative_assets
   WHERE tenant_id = $1
     AND source_job_id = $2
     AND source_type = 'generated_by_aries'
     AND orphaned_at IS NULL
   ORDER BY source_asset_id ASC
`;

// Synthesized posts are inserted `approved` so they immediately satisfy the
// calendar's unscheduled-approved backlog query (`published_status='approved'
// OR status='approved'`) and are schedulable. See the module header for why
// approved (not draft) is correct for this autonomous-mode deployment.
// Params: $1 tenantId, $2 jobId, $3 publishRunId, $4 platform,
// $5 caption, $6 idempotencyKey, $7 creativeAssetIds,
// $8 mediaType, $9 surface, $10 styleDimension, $11 styleValue,
// $12 widthPx, $13 heightPx, $14 durationSeconds
const INSERT_SYNTHESIZED_POST_SQL = `
  INSERT INTO posts (
    tenant_id, job_id, hermes_run_id, platform, media_type,
    caption, status, published_status, idempotency_key, creative_asset_ids, surface,
    style_dimension, style_value, width_px, height_px, duration_seconds
  ) VALUES (
    $1, $2, $3, $4, $8,
    $5, 'approved', 'approved', $6, $7, $9,
    $10, $11, $12, $13, $14
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
 * Parse `content_package[].platform_variants` into validated native copy.
 *
 * Every field is shape-checked here so the downstream caption builder can be
 * total: an unknown platform key, a non-string hook/body/cta, or a hashtags
 * value that is not a string array is DROPPED rather than coerced. A dropped
 * variant is not an error — the fan-out falls back to `adaptCaptionForPlatform`,
 * which is exactly today's behavior.
 */
function parsePlatformVariants(raw: unknown): Partial<Record<CrosspostPlatform, PlatformVariantCopy>> | undefined {
  const record = recordValue(raw);
  if (!record) return undefined;
  const out: Partial<Record<CrosspostPlatform, PlatformVariantCopy>> = {};
  let found = false;
  for (const [keyRaw, value] of Object.entries(record)) {
    const key = keyRaw.trim().toLowerCase();
    if (!(CROSSPOST_PLATFORMS as readonly string[]).includes(key)) continue;
    const variant = recordValue(value);
    if (!variant) continue;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const hook = str(variant.hook);
    const body = str(variant.body);
    const cta = str(variant.cta);
    if (!hook && !body && !cta) continue;
    const hashtags = Array.isArray(variant.hashtags)
      ? variant.hashtags
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : [];
    out[key as CrosspostPlatform] = { hook, body, cta, hashtags };
    found = true;
  }
  return found ? out : undefined;
}

/**
 * Normalize the raw `content_package` array into typed entries. Drops entries
 * with no usable post number or no recognized platform.
 *
 * `nativeEnabled` (AA-217 v2) widens the accepted platform set to include the
 * crosspost platforms and parses `platform_variants`. With it FALSE — the
 * default and the flag-OFF path — the accepted set and the produced entries are
 * exactly what they were before: an entry whose platforms name only `linkedin`
 * is still dropped in its entirety.
 */
function parseContentPackage(raw: unknown, nativeEnabled = false): ContentPackageEntry[] {
  if (!Array.isArray(raw)) return [];
  const accepted = nativeEnabled ? NATIVE_VALID_PLATFORMS : VALID_PLATFORMS;
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
          .filter((p) => accepted.has(p))
      : [];
    if (platforms.length === 0) return;
    const caption = buildCaption(record);
    if (!caption) return;
    // Story headline = the hook (punchy), falling back to the body, then the
    // first line of the caption. IG/FB stories show only the image, so this is
    // baked into the composed story pixels.
    const hook = typeof record.hook === 'string' ? record.hook.trim() : '';
    const body = typeof record.body === 'string' ? record.body.trim() : '';
    const headline = hook || body || caption.split('\n')[0] || '';
    const hashtags = Array.isArray(record.hashtags)
      ? record.hashtags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0)
      : [];
    const platformVariants = nativeEnabled ? parsePlatformVariants(record.platform_variants) : undefined;
    entries.push({
      postNumber,
      caption,
      headline,
      hashtags,
      platforms: Array.from(new Set(platforms)),
      // Conditional spread so a flag-OFF entry object is key-for-key identical
      // to pre-change (the byte-identical pin compares insert params, but this
      // keeps the in-memory shape honest too).
      ...(platformVariants ? { platformVariants } : {}),
    });
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
  const { jobId, tenantId, doc, publishRunId, pool, composeStoryAsset } = args;

  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return { inserted: 0, skipped: 0, total: 0, approvalRecordReady: false, droppedVideoNoAsset: 0, reason: 'no_tenant' };
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
      droppedVideoNoAsset: 0,
      reason: 'publish_package_present',
    };
  }

  // AA-217 v2 — platform-native content, per-tenant. This single boolean gates
  // EVERY behavior change in this module; false (the default) means every path
  // below is the pre-change path.
  const nativeEnabled = isPlatformNativeContentEnabled(process.env, tenantId);

  const entries = parseContentPackage(extractContentPackage(doc), nativeEnabled);
  if (entries.length === 0) {
    return {
      inserted: 0,
      skipped: 0,
      total: 0,
      approvalRecordReady: false,
      droppedVideoNoAsset: 0,
      reason: 'no_content_package',
    };
  }

  // Pull the ingested creative_assets so each post can be linked to its image.
  // post_number N (1-indexed) maps to the Nth creative asset in source_asset_id
  // order — the same ordering ingestProductionCreativeAssetsToDb preserves.
  // Dims (width_px/height_px/duration_seconds) are threaded into posts rows so
  // validateMediaForSurface has real metadata at dispatch time.
  type AssetInfo = {
    assetId: string;
    mediaType: string | null;
    widthPx: number | null;
    heightPx: number | null;
    durationSeconds: number | null;
  };
  let assetInfoByPostNumber = new Map<number, AssetInfo>();
  // Ingested VIDEO assets, in source_asset_id order. A video-shaped (post,
  // platform) target must link a real video creative — the post-number map
  // above indexes over ALL assets (image + video), so on a mixed job it can
  // point a reel at an image. Video shapes resolve from this list instead.
  let videoAssets: AssetInfo[] = [];
  try {
    const result = await pool.query(SELECT_CREATIVE_ASSETS_SQL, [tenantId, jobId]);
    const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
    const infos = rows.map((row) => {
      const assetId =
        typeof row.source_asset_id === 'string' && row.source_asset_id.trim()
          ? row.source_asset_id.trim()
          : String(row.id ?? '');
      const mediaType = typeof row.media_type === 'string' ? row.media_type.trim().toLowerCase() : null;
      const widthPx = typeof row.width_px === 'number' && Number.isFinite(row.width_px) ? row.width_px : null;
      const heightPx = typeof row.height_px === 'number' && Number.isFinite(row.height_px) ? row.height_px : null;
      const durationSeconds =
        typeof row.duration_seconds === 'number' && Number.isFinite(row.duration_seconds)
          ? row.duration_seconds
          : null;
      return { assetId, mediaType, widthPx, heightPx, durationSeconds };
    });
    assetInfoByPostNumber = new Map(infos.map((info, index) => [index + 1, info] as const));
    videoAssets = infos.filter((info) => info.mediaType === 'video');
  } catch (err) {
    console.warn('[synthesize-publish-posts] creative_assets lookup failed — continuing without media links', {
      jobId,
      tenantId,
      error: (err as Error)?.message ?? String(err),
    });
  }

  const scheduleShapeByKey = buildScheduleShapeLookup(doc);
  const videoPublishEnabled = isVideoPublishEnabled();

  // Reel-companion scope clamp. A job created by the weekly-reel trigger
  // (created_by = 'reel:<sourceWeeklyJobId>', videoRenderCount=1,
  // imageCreativeCount=0) exists to produce ONE reel — but the Hermes agent is
  // non-deterministic and has emitted a full 7-post weekly content package on
  // such jobs, which then synthesized + auto-scheduled a duplicate week of
  // feed posts alongside the parent weekly job's own package (the 2026-07-13
  // 6-identical-IG-posts-at-one-instant incident). Aries-side defense: for a
  // reel-companion job, only reel/video shapes may synthesize into posts;
  // feed-image entries are dropped with a loud log. The parent weekly job is
  // the sole owner of the week's feed posts.
  const isReelCompanionJob =
    typeof doc.created_by === 'string' && doc.created_by.startsWith('reel:');
  let reelClampDropped = 0;

  // PR2: stamp a stable visual-style lens (from the brand kit's style_vibe) on
  // each synthesized row so a later operator edit (regenerate/delete/review-
  // reject) has a concrete (dimension,value) to mark approved/rejected with no
  // LLM. Flag OFF (default) => null lens => NULL columns => byte-identical rows.
  const styleLens = isPostEditTasteLearningEnabled()
    ? visualStyleLens(doc.brand_kit?.style_vibe ?? null)
    : null;
  const styleDimension = styleLens?.dimension ?? null;
  const styleValue = styleLens?.value ?? null;

  // ---------------------------------------------------------------------
  // Primary-platform selection (AA-217).
  //
  // `alternateMode` means the tenant has NO Meta connection but does have a
  // connected x/linkedin/reddit channel: the week's content is re-targeted onto
  // those platforms instead of being synthesized as FB/IG rows that could never
  // publish. Every existing tenant resolves to `meta` and takes the byte-
  // identical legacy path below; with the flag OFF the resolver is not even
  // consulted, so there is not so much as an extra query.
  //
  // Alternate rows are produced by the SAME fan-out block the crosspost path
  // uses (see the `crosspostPlatforms` loop further down) — same eligibility
  // predicate (`entryHasFeedImage`), same captions, same idempotency keys, same
  // asset linkage. A LinkedIn-only tenant therefore gets exactly the rows a
  // Meta+LinkedIn tenant's fan-out would have produced from the same
  // content_package, minus the Meta originals.
  // ---------------------------------------------------------------------
  let crosspostPlatforms: CrosspostPlatform[] = [];
  let alternateMode = false;
  if (isAnyPlatformPublishEnabled()) {
    const resolution = await resolvePrimaryPublishPlatforms(tenantId, pool);
    if (resolution.mode === 'none') {
      // Defensive backstop: the publish-stage gate blocks zero-connection
      // tenants, but it fails OPEN on DB errors, so refuse here rather than
      // synthesize a week of posts with nowhere to send them.
      console.warn('[synthesize-publish-posts] no connected publishable platform — nothing synthesized', {
        jobId,
        tenantId,
      });
      return {
        inserted: 0,
        skipped: 0,
        total: 0,
        approvalRecordReady: false,
        droppedVideoNoAsset: 0,
        reason: 'no_connected_platform',
      };
    }
    if (resolution.mode === 'alternate') {
      alternateMode = true;
      crosspostPlatforms = resolution.platforms;
      console.info('[synthesize-publish-posts] alternate primary platforms — no Meta connection', {
        jobId,
        tenantId,
        platforms: resolution.platforms,
      });
    }
  }

  // Weekly cross-post fan-out (producer side). Resolve the eligible extra
  // platforms (x/linkedin/reddit) ONCE per synthesis call, not per entry. The
  // whole lookup is best-effort: a failure here must never break FB/IG
  // synthesis, so resolveCrosspostPlatforms fails open to [] and this is
  // additionally wrapped. Flag OFF (default) => empty list => byte-identical
  // synthesis output (no extra rows). Feed image posts only — never story/reel.
  // Skipped in alternate mode: those platforms are already the PRIMARY targets,
  // so re-resolving them would only risk double-counting.
  if (!alternateMode && isWeeklyCrosspostEnabled()) {
    try {
      crosspostPlatforms = await resolveCrosspostPlatforms(tenantId, pool);
    } catch (err) {
      console.warn('[synthesize-publish-posts] crosspost resolution failed — no fan-out', {
        jobId,
        tenantId,
        error: (err as Error)?.message ?? String(err),
      });
      crosspostPlatforms = [];
    }
  }

  let inserted = 0;
  let skipped = 0;
  let total = 0;
  let droppedVideoNoAsset = 0;

  for (const entry of entries) {
    const assetInfo = assetInfoByPostNumber.get(entry.postNumber);
    const assetId = assetInfo?.assetId;
    const creativeAssetIds = assetId ? [assetId] : [];
    // Track whether this entry produced at least one FB/IG FEED IMAGE row, so
    // the crosspost fan-out only mirrors real feed images (never a story/reel).
    let entryHasFeedImage = false;
    for (const platform of entry.platforms) {
      // Resolve the publish shape (surface + media_type) for this post/platform
      // from the strategist schedule; absent => feed/image (backward compat).
      const shape = scheduleShapeByKey.get(`${entry.postNumber}:${platform}`)
        ?? { surface: 'feed' as PostSurface, mediaType: 'image' as PostMediaType };

      // Rollout gate: when video publishing is OFF, strip reel/video entries so
      // the campaign still succeeds on the image/feed shapes. A reel has no
      // image fallback, so the whole (post, platform) target is skipped.
      if (!videoPublishEnabled && (shape.surface === 'reel' || shape.mediaType === 'video')) {
        skipped++;
        continue;
      }

      // Reel-companion jobs may only synthesize their reel/video output —
      // never a duplicate week of feed posts (see clamp doc-comment above).
      if (isReelCompanionJob && shape.surface !== 'reel' && shape.mediaType !== 'video') {
        reelClampDropped++;
        skipped++;
        continue;
      }

      // AA-217 alternate mode: this tenant has NO Meta connection, so an fb/ig
      // row could never be delivered — do not create one. But DO record whether
      // this target WOULD have been a feed image, because `entryHasFeedImage` is
      // exactly the predicate the fan-out below uses to decide whether this
      // entry produces alternate rows. We are past the same video/reel/clamp
      // gates the Meta path applies and ahead of the video-asset lookup (which
      // only concerns video shapes, and alternate mode has no video surface), so
      // per-entry eligibility is identical to the crosspost path by
      // construction: same N posts/week as a Meta+LinkedIn tenant's fan-out.
      if (alternateMode) {
        if (shape.surface === 'feed' && shape.mediaType === 'image') entryHasFeedImage = true;
        skipped++;
        continue;
      }

      // AA-217 v2: with platform-native content on, `entry.platforms` may now
      // name x/linkedin/reddit (parseContentPackage widened its accepted set),
      // and this loop is the MAIN insert loop — the one that writes Meta rows.
      // It must NEVER write a crosspost row.
      //
      // WHY THIS GUARD IS LOAD-BEARING: the fan-out below writes key
      // `${jobId}:${postNumber}:${platform}:feed`. If this loop could write the
      // same key with a different (non-native) caption, first-writer-wins on the
      // (tenant_id, platform, idempotency_key) unique index would silently
      // decide which copy ships. The fan-out is the SOLE producer of non-Meta
      // rows, so there is exactly one writer per key by construction.
      //
      // We still record feed-image eligibility, exactly as the alternateMode
      // branch above does — that is the predicate the fan-out uses, so an entry
      // targeted at linkedin only still produces its linkedin row.
      if (nativeEnabled && !META_PLATFORM_SET.has(platform)) {
        if (shape.surface === 'feed' && shape.mediaType === 'image') entryHasFeedImage = true;
        skipped++;
        continue;
      }

      // A video shape must link a real ingested VIDEO creative. The Hermes
      // content-generator only calls video_generate ~50% of the time on reel
      // jobs; when it doesn't, no video creative_asset exists and a synthesized
      // reel row can never publish (the dispatch route fails it terminally, and
      // before that it retry-spammed until campaign end — posts 415/416,
      // 2026-07-13). Drop the target instead; the caller decides whether a
      // missing reel is job-fatal (reel-companion) or tolerable (weekly job
      // whose feed posts still succeed). When a video asset DOES exist, link it
      // explicitly — the post-number map indexes ALL assets, so on a mixed job
      // it can point a reel at an image.
      let rowAssetInfo: AssetInfo | undefined = assetInfo;
      let rowCreativeAssetIds = creativeAssetIds;
      if (shape.mediaType === 'video') {
        const videoAsset = assetInfo?.mediaType === 'video' ? assetInfo : videoAssets[0];
        if (!videoAsset) {
          droppedVideoNoAsset++;
          skipped++;
          continue;
        }
        rowAssetInfo = videoAsset;
        rowCreativeAssetIds = [videoAsset.assetId];
      }

      if (shape.surface === 'feed' && shape.mediaType === 'image') entryHasFeedImage = true;

      total++;
      // 4-segment idempotency key so a feed + reel on the same post number and
      // platform do not collide on the (tenant_id, platform, idempotency_key)
      // unique index. parsePostNumberFromIdempotencyKey tolerates the 4th
      // segment (it slices to the first colon after the job id).
      const idempotencyKey = `${jobId}:${entry.postNumber}:${platform}:${shape.surface}`;
      try {
        const result = await pool.query(INSERT_SYNTHESIZED_POST_SQL, [
          tenantId,           // $1
          jobId,              // $2
          publishRunId,       // $3
          platform,           // $4
          entry.caption,      // $5
          idempotencyKey,     // $6
          rowCreativeAssetIds, // $7
          shape.mediaType,    // $8
          shape.surface,      // $9
          styleDimension,     // $10
          styleValue,         // $11
          rowAssetInfo?.widthPx ?? null,          // $12
          rowAssetInfo?.heightPx ?? null,         // $13
          rowAssetInfo?.durationSeconds ?? null,  // $14
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

    // Weekly cross-post fan-out — and, in AA-217 alternate mode, the PRIMARY
    // row producer. The block is deliberately shared between the two: an
    // alternate-mode tenant's rows are produced by the very same code, with the
    // very same eligibility predicate, captions, keys and asset linkage, so
    // "LinkedIn-only" output is provably identical to the linkedin rows a
    // Meta+LinkedIn tenant would get from the same content_package.
    //
    // When enabled AND this entry produced a real
    // FB/IG feed image, mirror it to each eligible extra platform
    // (x/linkedin/reddit) with a platform-adapted caption and the SAME image
    // linkage. Feed/image surface ONLY (entryHasFeedImage gates this). The whole
    // block is wrapped so any fan-out error degrades to no-crosspost — the FB/IG
    // rows above are already persisted and unaffected. The idempotency key
    // carries the platform, so a reconciler re-delivery hits ON CONFLICT DO
    // NOTHING and never duplicates.
    if (entryHasFeedImage && crosspostPlatforms.length > 0) {
      for (const platform of crosspostPlatforms) {
        total++;
        const idempotencyKey = `${jobId}:${entry.postNumber}:${platform}:feed`;
        try {
          // AA-217 v2: prefer the strategist's NATIVE copy for this platform.
          // `buildVariantCaption` returns null for a missing/blank variant and
          // the adapter takes over — Hermes is non-deterministic, so a variant
          // is never allowed to be load-bearing. Flag OFF ⇒ platformVariants is
          // always undefined ⇒ this is the adapter, byte-identical.
          const nativeCaption = nativeEnabled
            ? buildVariantCaption(platform, entry.platformVariants?.[platform])
            : null;
          const adaptedCaption =
            nativeCaption ?? adaptCaptionForPlatform(platform, entry.caption, entry.hashtags);
          const result = await pool.query(INSERT_SYNTHESIZED_POST_SQL, [
            tenantId,           // $1
            jobId,              // $2
            publishRunId,       // $3
            platform,           // $4
            adaptedCaption,     // $5
            idempotencyKey,     // $6
            creativeAssetIds,   // $7 — same rendered feed image as FB/IG
            'image',            // $8 media_type
            'feed',             // $9 surface
            styleDimension,     // $10
            styleValue,         // $11
            assetInfo?.widthPx ?? null,          // $12
            assetInfo?.heightPx ?? null,         // $13
            assetInfo?.durationSeconds ?? null,  // $14
          ]);
          if ((result.rowCount ?? 0) > 0) {
            inserted++;
          } else {
            skipped++;
          }
        } catch (err) {
          console.warn('[synthesize-publish-posts] crosspost row insert failed — skipping', {
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
  }

  // Image-story auto-promotion. When the weekly scope requested image stories
  // (`scope.story_count > 0`), promote the first N content_package entries into
  // ADDITIONAL `surface='story'` posts that reuse the same Hermes-generated
  // creative. This is what makes image stories flow automatically end-to-end:
  // the upstream Hermes strategist/publish stages do not emit `placement:'story'`
  // today, so without this an operator's requested stories would never
  // materialise. Story posts publish LIVE via the scheduled-dispatch path (Meta
  // rejects scheduled stories; the dispatch route never forwards `scheduledFor`).
  //
  // Default `story_count=0` => this block is inert and feed-only behavior is
  // byte-for-byte unchanged. Idempotent + non-colliding: the per-row key carries
  // the surface as its 4th segment, so a story post (`:story`) never collides
  // with the feed post (`:feed`) for the same (post_number, platform); a
  // replayed callback hits ON CONFLICT DO NOTHING. If a future Hermes schedule
  // DOES emit a story placement for one of these posts, the main loop already
  // inserted that `:story` row and this promotion is a no-op for it.
  if (reelClampDropped > 0) {
    console.info('[synthesize-publish-posts] reel-companion clamp dropped non-reel entries', {
      jobId,
      tenantId,
      createdBy: doc.created_by,
      dropped: reelClampDropped,
    });
  }

  // LOUD: a requested video post could not be synthesized because the job
  // never ingested a video creative_asset (the Hermes agent did not render a
  // video). This is the signal the reel-companion outcome gate keys off to
  // fail the job instead of leaving it approved-with-no-reel.
  if (droppedVideoNoAsset > 0) {
    console.error('[synthesize-publish-posts] video post targets dropped — no ingested video creative_asset', {
      jobId,
      tenantId,
      createdBy: doc.created_by ?? null,
      dropped: droppedVideoNoAsset,
    });
  }

  // Story promotion is also feed-derived content — a reel-companion job never
  // owns the week's stories either (same clamp rationale as above).
  //
  // Alternate mode skips stories entirely: a story is a Meta surface (this
  // block iterates `entry.platforms`, which parseContentPackage restricts to
  // fb/ig) and x/linkedin/reddit have no story equivalent here. Promoting them
  // for a tenant with no Meta connection would recreate the exact bug this
  // ticket fixes — undeliverable rows. Such a tenant's week is feed posts only.
  const storyBudget = isReelCompanionJob || alternateMode ? 0 : readRequestedStoryCount(doc);

  // TRUTHFULNESS MARKER (deliverable A). The clamp above is silent: the operator
  // asked for `scope.story_count` stories and, on an alternate-primary tenant,
  // gets zero — and until now nothing on the doc, in the report, or in the UI
  // said so. Record the gap so every surface can state it (see
  // ./delivery-composition.ts for why it lives in `stages.publish.outputs`).
  //
  // The reel companion is skipped by the SAME predicate, in
  // orchestrator.ts (`resolvePrimaryPublishPlatforms(...).mode !== 'meta'`), at
  // job-start time. It is re-derived here rather than written there on purpose:
  // that skip runs in a detached best-effort IIFE moments after the job doc was
  // saved, so a load-modify-save from it would race the pipeline's own writes.
  // The condition is identical, so deriving it at synthesis time is exact — and
  // it is qualified by the reel flags, because "we skipped your reel" is untrue
  // in a deployment where no reel would have been produced anyway.
  //
  // Reel-companion jobs are excluded: such a job is not the week, it IS the reel
  // attempt, and it never owns the week's stories.
  if (alternateMode && !isReelCompanionJob) {
    recordDeliveryComposition(doc, {
      platforms: crosspostPlatforms,
      storiesRequested: readRequestedStoryCount(doc),
      reelCompanionSkipped:
        doc.job_type === 'weekly_social_content' && isWeeklyReelEnabled() && videoPublishEnabled,
    });
  }

  if (storyBudget > 0) {
    for (const entry of entries.slice(0, storyBudget)) {
      const assetInfo = assetInfoByPostNumber.get(entry.postNumber);
      const assetId = assetInfo?.assetId;
      // A story is single-media with no text fallback. Skip entries with no
      // linked creative rather than emit a media-less story that would fail at
      // publish (publishInstagram requires >= 1 media url).
      if (!assetId) {
        skipped++;
        continue;
      }
      // Compose a story image (headline + brand CTA baked into a 9:16 canvas)
      // ONCE per entry and reuse it across the entry's platforms. Meta stories
      // render only pixels, so a bare creative would post wordless. Fall back to
      // the raw creative if no composer is wired or composition fails.
      let storyAssetIds: string[] = [assetId];
      if (composeStoryAsset) {
        const composedId = await composeStoryAsset({
          tenantId,
          jobId,
          baseAssetId: assetId,
          headline: entry.headline,
        }).catch(() => null);
        if (composedId) storyAssetIds = [composedId];
      }
      // A story is a META surface. This filter is provably a no-op with the
      // platform-native flag OFF (parseContentPackage restricted platforms to
      // exactly META_PUBLISH_PLATFORMS), and with it ON it is what stops an
      // entry that also names linkedin/x/reddit from manufacturing a "linkedin
      // story" row that could never be delivered.
      for (const platform of entry.platforms.filter((p) => META_PLATFORM_SET.has(p))) {
        total++;
        const idempotencyKey = `${jobId}:${entry.postNumber}:${platform}:story`;
        try {
          const result = await pool.query(INSERT_SYNTHESIZED_POST_SQL, [
            tenantId,        // $1
            jobId,           // $2
            publishRunId,    // $3
            platform,        // $4
            entry.caption,   // $5
            idempotencyKey,  // $6
            storyAssetIds,   // $7
            'image',         // $8 media_type (story images are always image type)
            'story',         // $9 surface
            styleDimension,  // $10
            styleValue,      // $11
            null,            // $12 width_px (composed story image — dims not carried from base asset)
            null,            // $13 height_px
            null,            // $14 duration_seconds
          ]);
          if ((result.rowCount ?? 0) > 0) {
            inserted++;
          } else {
            skipped++;
          }
        } catch (err) {
          console.warn('[synthesize-publish-posts] story row insert failed — skipping', {
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

  return { inserted, skipped, total, approvalRecordReady, droppedVideoNoAsset };
}
