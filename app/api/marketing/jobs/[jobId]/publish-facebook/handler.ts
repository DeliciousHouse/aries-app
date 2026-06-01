
import { loadTenantContextOrResponse } from '@/lib/tenant-context-http';
import { loadSocialContentJobRuntime } from '@/backend/marketing/runtime-state';
import { buildSocialContentWorkspaceView } from '@/backend/marketing/workspace-views';
import { recomputeAndPersistPendingApprovalCount } from '@/backend/marketing/runtime-views';
import {
  findLatestMarketingApprovalRecord,
  loadMarketingApprovalRecord,
  MarketingApprovalLockError,
  releaseMarketingApprovalPlatformClaim,
  withMarketingApprovalLock,
  saveMarketingApprovalRecord,
} from '@/backend/marketing/approval-store';
import { loadSocialCopyArtifact } from '@/backend/social-content/social-copy-store';
import {
  classifyMetaPublishFailure,
  classifyMetaPublishFailureKind,
  isMetaProvider,
  MetaPublishError,
  normalizeMetaPlacement,
  publishToMetaGraph,
} from '@/backend/integrations/meta-publishing';
import { runPublishVerification } from '@/backend/integrations/publish-verification';
import { toSignedPublicUrl } from '@/app/api/publish/dispatch/handler';
import { resolveSignableBasename } from '@/backend/marketing/signable-basename';
import { pool } from '@/lib/db';

type FacebookPublishBody = {
  caption?: string;
  /** 'story' publishes an ephemeral FB story; anything else is a feed post. */
  placement?: string;
};

async function readBody(req: Request): Promise<FacebookPublishBody> {
  try {
    return (await req.json()) as FacebookPublishBody;
  } catch {
    return {};
  }
}

function facebookPermalink(platformPostId: string): string | null {
  if (!platformPostId) return null;
  return `https://www.facebook.com/${encodeURIComponent(platformPostId)}`;
}

export async function handleFacebookPublish(req: Request, jobId: string) {
  const tenantResult = await loadTenantContextOrResponse();
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantId } = tenantResult.tenantContext;

  const runtimeDoc = await loadSocialContentJobRuntime(jobId);
  if (!runtimeDoc || runtimeDoc.tenant_id !== tenantId) {
    return new Response(
      JSON.stringify({ error: 'Job not found.', reason: 'job_not_found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  const body = await readBody(req);

  // Resolve caption: caller-provided > social-copy.json facebook_feed > production content_package
  let caption = typeof body.caption === 'string' ? body.caption.trim() : '';
  if (!caption) {
    try {
      const socialCopy = await loadSocialCopyArtifact(jobId);
      if (socialCopy) {
        const fbPost = socialCopy.posts.find((p) => p.channel === 'facebook_feed');
        if (fbPost) {
          const hashtags = fbPost.hashtags.length > 0 ? `\n\n${fbPost.hashtags.join(' ')}` : '';
          caption = `${fbPost.caption}${hashtags}`;
        }
      }
    } catch {
      // Non-fatal: try content_package fallback below
    }
  }
  // Fallback: when social-copy.json is absent (ARIES_SOCIAL_COPY_FINALIZE_ENABLED=0),
  // derive the caption from the production stage's content_package[].
  // Prefer a post targeting 'facebook' or 'meta', fall back to the first post.
  if (!caption) {
    try {
      const contentPackage = runtimeDoc.stages?.production?.primary_output?.content_package;
      if (Array.isArray(contentPackage) && contentPackage.length > 0) {
        type ContentPost = { hook?: string; body?: string; cta?: string; hashtags?: string[]; platforms?: string[] };
        const posts = contentPackage as ContentPost[];
        const fbPost = posts.find(
          (p) => Array.isArray(p.platforms) && p.platforms.some((pl: string) => pl === 'facebook' || pl === 'meta'),
        ) ?? posts[0];
        if (fbPost) {
          const parts = [fbPost.hook, fbPost.body, fbPost.cta].filter(Boolean).join('\n\n');
          const tags = Array.isArray(fbPost.hashtags) && fbPost.hashtags.length > 0
            ? `\n\n${fbPost.hashtags.join(' ')}`
            : '';
          caption = `${parts}${tags}`.trim();
        }
      }
    } catch {
      // Non-fatal: proceed without caption if content_package is unavailable
    }
  }

  // Find approved image from creative review. Capture the asset's id alongside
  // the URL: it is persisted to posts.creative_asset_ids so the scheduled
  // dispatch resolver scopes media per-post instead of falling back to job
  // scope (assetId matches creative_assets.id or .source_asset_id).
  let mediaUrl: string | null = null;
  let publishedAssetId: string | null = null;
  try {
    const workspaceView = await buildSocialContentWorkspaceView(jobId);
    const approvedAssets = workspaceView.creativeReview?.assets.filter(
      (a) => a.status === 'approved' && (a.contentType?.startsWith('image/') || a.contentType === null),
    ) ?? [];

    for (const asset of approvedAssets) {
      const url = asset.fullPreviewUrl || asset.previewUrl;
      if (url) {
        mediaUrl = url;
        publishedAssetId = asset.assetId;
        break;
      }
    }
  } catch {
    // Non-fatal: proceed without media (caption-only post)
  }

  // Sign the media URL into a public proxy URL.
  const signedMediaUrls: string[] = [];
  if (mediaUrl) {
    // Resolve id-addressed internal URLs to their on-disk basename before
    // signing (Option A); legacy basename URLs pass through unchanged.
    const basename = await resolveSignableBasename(mediaUrl, tenantId);
    if (basename) {
      signedMediaUrls.push(toSignedPublicUrl(mediaUrl, tenantId, basename));
    }
  }

  // Run all failure checks that don't depend on the approval claim BEFORE
  // consuming it, so a missing-content or unavailable-provider failure never
  // leaves a platform falsely marked consumed.
  if (!caption && signedMediaUrls.length === 0) {
    return new Response(
      JSON.stringify({ status: 'error', reason: 'no_content', message: 'Neither caption nor approved image is available for this job.' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    );
  }

  if (!isMetaProvider('facebook')) {
    return new Response(
      JSON.stringify({ status: 'error', reason: 'provider_unavailable', message: 'Facebook provider is not available.' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  // Validate and consume the approval record. Consumption is deliberately the
  // last step before the publish call: if the publish call itself fails, the
  // claim is rolled back below so a retry can re-attempt this platform.
  // Per-platform consumption: each platform independently claims the approval via consumed_platforms[].
  // The record is only flipped to 'consumed' once all configured platforms have published.
  const PLATFORM_KEY = 'facebook';
  let approvalId: string | undefined;
  const latestRecord = findLatestMarketingApprovalRecord({
    marketingJobId: jobId,
    tenantId,
    marketingStage: 'publish',
    statuses: ['approved'],
  });
  if (!latestRecord) {
    return new Response(
      JSON.stringify({
        status: 'error',
        reason: 'publish_requires_approval',
        message: 'No approved publish approval record found for this job.',
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }
  approvalId = latestRecord.approval_id;

  let consumeError: Response | null = null;
  try {
    await withMarketingApprovalLock(approvalId, async () => {
      const record = loadMarketingApprovalRecord(approvalId as string);
      if (!record) {
        consumeError = new Response(
          JSON.stringify({ status: 'error', reason: 'publish_requires_approval', message: `Approval record ${approvalId} not found.` }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
        return;
      }
      if (record.tenant_id !== tenantId) {
        consumeError = new Response(
          JSON.stringify({ status: 'error', reason: 'publish_requires_approval', message: 'Approval record does not belong to this tenant.' }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
        return;
      }
      if (record.consumed_platforms.includes(PLATFORM_KEY)) {
        consumeError = new Response(
          JSON.stringify({ status: 'error', reason: 'publish_approval_already_consumed', message: `Approval ${approvalId} was already consumed for platform '${PLATFORM_KEY}'.` }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
        return;
      }
      // Legacy guard: fully consumed approval (all platforms done) must not be re-used.
      if (record.status === 'consumed') {
        consumeError = new Response(
          JSON.stringify({ status: 'error', reason: 'publish_approval_already_consumed', message: `Approval ${approvalId} was already consumed.` }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
        return;
      }
      if (record.status !== 'approved') {
        consumeError = new Response(
          JSON.stringify({ status: 'error', reason: 'publish_requires_approval', message: `Approval ${approvalId} is in status '${record.status}', not 'approved'.` }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
        return;
      }
      // Register this platform as consumed.
      record.consumed_platforms = [...record.consumed_platforms, PLATFORM_KEY];
      // If all configured platforms have now published, mark the approval fully consumed.
      const configuredPlatforms: string[] = record.publish_config?.live_publish_platforms ?? [];
      const allConsumed = configuredPlatforms.length > 0
        && configuredPlatforms.every((p) => record.consumed_platforms.includes(p));
      if (allConsumed) {
        record.status = 'consumed';
        record.resolved_at = new Date().toISOString();
      }
      saveMarketingApprovalRecord(record);
    });
  } catch (error) {
    if (error instanceof MarketingApprovalLockError) {
      return new Response(
        JSON.stringify({ status: 'error', reason: 'publish_approval_already_consumed', message: 'Approval is currently being processed by another request.' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }
    throw error;
  }
  if (consumeError) return consumeError;

  let publishSucceeded = false;
  try {
    const published = await publishToMetaGraph({
      tenantId,
      provider: 'facebook',
      content: caption,
      mediaUrls: signedMediaUrls,
      placement: normalizeMetaPlacement(typeof body.placement === 'string' ? body.placement : undefined),
      scheduledFor: null,
    });
    publishSucceeded = true;

    const verification = await runPublishVerification({
      tenantId,
      provider: published.provider,
      caption,
      primaryOutput: { platform_post_id: published.platformPostId },
      pool,
      jobId,
      idempotencyKey: `${jobId}:publish:facebook:1`,
      creativeAssetIds: publishedAssetId ? [publishedAssetId] : null,
    });

    // A successful publish inserts a job-linked posts row (published_status), which
    // feeds countPublishedPostsForJob -> the denormalized dashboard projection's
    // live/scheduled/published counts. That's a DB-only write the projection's
    // runtimeDoc.updated_at freshness stamp does NOT catch, so refresh the
    // projection here (non-fatal) or the campaign list/dashboard would render
    // stale pre-publish counts until an unrelated mutation recomputes.
    await recomputeAndPersistPendingApprovalCount(jobId).catch((err) => {
      console.error('[publish-facebook] denorm recompute failed', err);
    });

    const permalink = facebookPermalink(published.platformPostId);

    return new Response(
      JSON.stringify({
        status: 'published',
        platform_post_id: published.platformPostId,
        permalink,
        connection_id: published.connectionId,
        publish_verification: verification,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  } catch (error) {
    // Two outcome classes need opposite handling:
    //
    //   "Definitely never posted" — a requestGraphJson network/HTTP/4xx failure
    //   (or any pre-publish failure). The Graph publish call never succeeded, so
    //   the post never went live. Safe to roll back the platform claim and let a
    //   retry re-attempt this platform.
    //
    //   "Outcome unknown" — facebook_publish_missing_id: the Graph feed call was
    //   accepted (2xx) but Aries got no post id back. The post MAY be live. The
    //   claim must be LEFT in place and the failure surfaced as
    //   needs_manual_reconciliation; auto-retry is forbidden because retrying a
    //   publish that secretly succeeded creates a duplicate post.
    const outcomeUnknown = classifyMetaPublishFailure(error) === 'outcome_unknown';

    // Roll back the platform claim only when the publish call definitely never
    // posted. A post that went live but failed verification, or an unconfirmed
    // (outcome-unknown) publish, keeps its claim — neither may be re-attempted.
    if (!publishSucceeded && !outcomeUnknown) {
      try {
        await releaseMarketingApprovalPlatformClaim(approvalId as string, PLATFORM_KEY);
      } catch (rollbackError) {
        // Best-effort rollback; surface the original publish error regardless.
        // Log loudly — a swallowed lock error here leaves the platform claim
        // stuck, silently blocking every future retry of this platform. The
        // warning gives an operator the IDs needed to clear the claim by hand.
        console.warn('[publish-facebook] approval claim rollback failed', {
          approvalId,
          platform: PLATFORM_KEY,
          error: String((rollbackError as Error)?.message ?? rollbackError),
        });
      }
    }

    if (outcomeUnknown) {
      // Claim deliberately left in place; never auto-retry.
      console.warn('[publish-facebook] publish outcome unknown — needs manual reconciliation', {
        approvalId,
        platform: PLATFORM_KEY,
        jobId,
        code: (error as MetaPublishError).code,
      });
      return new Response(
        JSON.stringify({
          status: 'needs_manual_reconciliation',
          reason: (error as MetaPublishError).code,
          message: `${(error as MetaPublishError).message} The Facebook publish call was accepted but the post id could not be confirmed; verify on Facebook before any retry — Aries will not auto-retry this post.`,
          retryable: false,
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      );
    }

    if (error instanceof MetaPublishError && classifyMetaPublishFailureKind(error) === 'auth') {
      // The tenant's Meta connection is missing/expired. Terminal like any other
      // retryable:false failure, but operator-actionable: surface a distinct
      // reconnect signal instead of an opaque publish_failed.
      console.warn('[publish-facebook] publish failed — Meta account needs reconnect', {
        approvalId,
        platform: PLATFORM_KEY,
        jobId,
        code: error.code,
      });
      return new Response(
        JSON.stringify({
          status: 'error',
          reason: 'needs_reconnect',
          code: error.code,
          message: `${error.message} Reconnect your Facebook/Meta account to resume publishing.`,
          retryable: false,
        }),
        { status: error.status, headers: { 'content-type': 'application/json' } },
      );
    }

    if (error instanceof MetaPublishError) {
      return new Response(
        JSON.stringify({ status: 'error', reason: error.code, message: error.message }),
        { status: error.status, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ status: 'error', reason: 'publish_failed', message: 'An unexpected error occurred' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}
