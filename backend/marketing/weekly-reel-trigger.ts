/**
 * Weekly-reel companion: when ARIES_WEEKLY_REEL_ENABLED is on (and
 * ARIES_VIDEO_PUBLISH_ENABLED is also on — the upstream video gate), fire a
 * dedicated one-off reel job alongside each weekly_social_content job. The
 * reel job runs on its own production-stage slot so it never contends with the
 * weekly image pipeline.
 *
 * Idempotency: every reel companion is stamped with
 * `createdBy = "reel:<sourceWeeklyJobId>"`. findRecentJobIdForTenant scans
 * existing one_off_post docs for that exact marker (sinceEpochMs=0 = all
 * time), so a reconciler re-delivery or a re-fire after a lost response
 * collapses onto the already-created reel job rather than starting a second
 * one. The sourceWeeklyJobId is a UUID so the marker is globally unique; no
 * legitimate reel job for a different weekly run is ever collapsed.
 *
 * Best-effort: the whole function is wrapped in try/catch and never throws.
 * The caller MUST swallow any rejection — a reel-trigger failure must never
 * affect the weekly job that spawned it.
 *
 * Note on the video gate: the clip only renders and publishes when
 * ARIES_VIDEO_PUBLISH_ENABLED is also on. If video publishing is off, this
 * helper returns early with reason:'video_publish_off' so we don't waste a
 * Hermes run generating a video that can never reach Meta.
 */
import { isWeeklyReelEnabled } from '@/backend/marketing/weekly-reel-env';
import { startSocialContentJob } from '@/backend/marketing/orchestrator';
import { findRecentJobIdForTenant } from '@/backend/marketing/runtime-state';
import { loadTenantBrandKit } from '@/backend/marketing/brand-kit';

// Deterministic createdBy marker: encodes the source weekly job id so the
// idempotency lookup is scoped to exactly that one reel pairing.
function reelCreatedBy(sourceWeeklyJobId: string): string {
  return `reel:${sourceWeeklyJobId}`;
}

/**
 * Mirrored from synthesize-publish-posts.ts (same env var, same semantics).
 * Inlined here to keep the ownership boundary clean — synthesize-publish-posts
 * is touched by a different agent in the video-publish-foundation build, and
 * importing from it would create a brittle cross-agent dependency. Update both
 * sites when the env-var name changes.
 */
function isVideoPublishEnabled(): boolean {
  const raw = (process.env.ARIES_VIDEO_PUBLISH_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

type FireReelJobResult = { fired: boolean; reelJobId?: string; reason?: string };

const REEL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export async function maybeFireWeeklyReelJob(
  args: { tenantId: number; sourceWeeklyJobId: string; brandUrl?: string | null },
): Promise<FireReelJobResult> {
  try {
    // Master switch: the reel companion feature must be explicitly enabled.
    if (!isWeeklyReelEnabled()) {
      return { fired: false, reason: 'flag_off' };
    }

    // Upstream gate: if video publishing is off, a generated reel can never
    // reach Meta, so there is no value in running the production stage.
    if (!isVideoPublishEnabled()) {
      return { fired: false, reason: 'video_publish_off' };
    }

    const tenantIdStr = String(args.tenantId);
    const createdBy = reelCreatedBy(args.sourceWeeklyJobId);

    // Idempotency: scan one_off_post docs created in the last 7 days for the
    // deterministic createdBy marker. The reel companion fires immediately
    // after the weekly job, so a 7-day window is more than wide enough while
    // avoiding an all-time readdir+JSON.parse of every marketing job doc.
    // The marker is globally unique per sourceWeeklyJobId so no legitimate
    // run for a different weekly run is ever collapsed.
    const existingJobId = await findRecentJobIdForTenant(tenantIdStr, {
      jobType: 'one_off_post',
      createdBy,
      sinceEpochMs: Date.now() - REEL_LOOKBACK_MS,
    });
    if (existingJobId) {
      return { fired: false, reelJobId: existingJobId, reason: 'already_exists' };
    }

    return await fireReelCompanionJob({ tenantIdStr, createdBy, brandUrlOverride: args.brandUrl ?? null });
  } catch (err) {
    // Best-effort: surface the reason for observability but never propagate.
    const msg = err instanceof Error ? err.message : String(err);
    return { fired: false, reason: `error:${msg.slice(0, 120)}` };
  }
}

/**
 * One-shot automatic retry for a reel-companion job that completed WITHOUT ever
 * ingesting a video creative_asset (the Hermes content-generator only calls
 * video_generate ~50% of the time on reel jobs). Mirrors the regenerate seam's
 * shape — the failed job is preserved and a NEW run is submitted — but at job
 * granularity: a fresh one_off_post reel job runs the full pipeline cleanly, so
 * no terminal-doc callback surgery is needed.
 *
 * Bounded to ONE retry, structurally:
 *   - it only fires for an ORIGINAL companion (`created_by` = `reel:<uuid>`,
 *     never the retry's own `reel:retry:<uuid>` marker), and
 *   - the retry marker `reel:retry:<failedReelJobId>` is idempotent via
 *     findRecentJobIdForTenant, so reconciler re-delivery of the failed job's
 *     completion collapses onto the one retry.
 * The `reel:` prefix is load-bearing: it keeps the retry job inside the
 * reel-companion synthesis clamp (only reel/video shapes may synthesize) and
 * the reel-companion outcome gate (a retry that also renders no video is
 * marked failed, with no further retry).
 *
 * Best-effort: never throws — a retry-submission failure leaves the job failed,
 * which is the correct loud terminal state.
 */
export async function maybeFireReelVideoRetryJob(
  args: {
    tenantId: number | string;
    failedReelJobId: string;
    failedReelCreatedBy: string | null | undefined;
    brandUrl?: string | null;
  },
): Promise<FireReelJobResult> {
  try {
    if (!isWeeklyReelEnabled()) {
      return { fired: false, reason: 'flag_off' };
    }
    if (!isVideoPublishEnabled()) {
      return { fired: false, reason: 'video_publish_off' };
    }

    const createdBy = typeof args.failedReelCreatedBy === 'string' ? args.failedReelCreatedBy : '';
    if (!createdBy.startsWith('reel:')) {
      return { fired: false, reason: 'not_reel_companion' };
    }
    // One-shot bound: a retry job never retries itself.
    if (createdBy.startsWith('reel:retry:')) {
      return { fired: false, reason: 'retry_exhausted' };
    }

    const tenantIdStr = String(args.tenantId);
    const retryCreatedBy = `reel:retry:${args.failedReelJobId}`;

    const existingJobId = await findRecentJobIdForTenant(tenantIdStr, {
      jobType: 'one_off_post',
      createdBy: retryCreatedBy,
      sinceEpochMs: Date.now() - REEL_LOOKBACK_MS,
    });
    if (existingJobId) {
      return { fired: false, reelJobId: existingJobId, reason: 'already_exists' };
    }

    return await fireReelCompanionJob({
      tenantIdStr,
      createdBy: retryCreatedBy,
      brandUrlOverride: args.brandUrl ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { fired: false, reason: `error:${msg.slice(0, 120)}` };
  }
}

/**
 * Shared submission core for the weekly companion and its one-shot retry:
 * brand-kit-derived brief + startSocialContentJob with a video-only media
 * demand. Callers own gating + idempotency; this only builds and submits.
 */
async function fireReelCompanionJob(
  args: { tenantIdStr: string; createdBy: string; brandUrlOverride: string | null },
): Promise<FireReelJobResult> {
  try {
    const { tenantIdStr, createdBy } = args;

    // Load the brand kit to build a brand-aware reel brief. A missing kit is
    // non-fatal — we fall back to generic-but-valid values so the job submits.
    const brandKit = await loadTenantBrandKit(tenantIdStr);
    const brandName = brandKit?.brand_name?.trim() || 'Brand';
    const offerSummary = (brandKit?.offer_summary || brandKit?.positioning || '').trim();
    const styleVibe = (brandKit?.style_vibe || '').trim();

    // Resolve brand URL: prefer the caller-provided value (already validated
    // by the weekly job), fall back to the brand kit's source URL.
    const brandUrl =
      (typeof args.brandUrlOverride === 'string' && args.brandUrlOverride.trim().length > 0
        ? args.brandUrlOverride.trim()
        : null) ??
      brandKit?.source_url?.trim() ??
      null;

    if (!brandUrl) {
      return { fired: false, reason: 'missing_brand_url' };
    }

    // Build a concise, brand-derived reel brief. The name field is what Hermes
    // reads from one_off_brief; it carries the 9:16 format requirement + the
    // brand's value proposition so the content-generator agent knows this is a
    // Reel, not a feed post. videoRenderCount=1 + imageCreativeCount=0 in the
    // payload confirms the format to the production stage.
    const valueProp = offerSummary || `${brandName} brand content`;
    const styleNote = styleVibe ? ` Style: ${styleVibe}.` : '';
    const reelBriefName =
      `9:16 Vertical Brand Reel — ${valueProp}.${styleNote}`.trim();

    // 7-day window gives the production agent a meaningful campaign horizon.
    const campaignEndDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // businessType is required by ensureSocialContentJobInput. Derive from the
    // brand kit's offer summary or use a safe, non-empty default.
    const businessType = offerSummary || 'brand content';

    // NOTE on idempotency: startSocialContentJob always generates its own jobId
    // internally (makeSocialContentJobId()) — StartSocialContentJobRequest does
    // not accept an explicit jobId or idempotency key. The createdBy marker
    // above is therefore the only idempotency hook. A concurrent double-fire
    // within the same 7-day window can still produce two jobs if the
    // findRecentJobIdForTenant check-then-create races. This residual window is
    // bounded by the weekly-trigger worker's atomic per-tenant per-week claim
    // (conditional UPDATE on marketing_schedule.last_triggered_at), which
    // prevents a second weekly job from firing in the same weekly window and
    // thus limits a concurrent double-fire to a pathological worker restart.
    const result = await startSocialContentJob({
      tenantId: tenantIdStr,
      jobType: 'one_off_post',
      createdBy,
      payload: {
        brandUrl,
        businessType,
        // payload.jobType drives createSocialContentJobRuntimeDocument's
        // resolvedJobType — must match the outer jobType for one_off_brief to
        // be attached by buildOneOffBriefForArgs.
        jobType: 'one_off_post',
        // one_off_brief fields read by buildOneOffBriefForArgs (name +
        // campaignEndDate + cta are all required; absent = no brief attached).
        oneOff: {
          name: reelBriefName,
          campaignEndDate,
          cta: 'Shop Now',
        },
        // Media demand: one video only. imageCreativeCount=0 ensures the
        // production agent generates only the Reel and not feed images.
        imageCreativeCount: 0,
        imageCreativesCount: 0,
        videoRenderCount: 1,
        renderVideoAfterApproval: true,
        staticPostCount: 1,
      },
    });

    return { fired: true, reelJobId: result.jobId };
  } catch (err) {
    // Best-effort: surface the reason for observability but never propagate.
    const msg = err instanceof Error ? err.message : String(err);
    return { fired: false, reason: `error:${msg.slice(0, 120)}` };
  }
}
