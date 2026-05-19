import path from 'node:path';

import { loadTenantContextOrResponse } from '@/lib/tenant-context-http';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { buildCampaignWorkspaceView } from '@/backend/marketing/workspace-views';
import {
  findLatestMarketingApprovalRecord,
  loadMarketingApprovalRecord,
  MarketingApprovalLockError,
  withMarketingApprovalLock,
  saveMarketingApprovalRecord,
} from '@/backend/marketing/approval-store';
import { loadSocialCopyArtifact } from '@/backend/social-content/social-copy-store';
import {
  isMetaProvider,
  MetaPublishError,
  publishToMetaGraph,
} from '@/backend/integrations/meta-publishing';
import { runPublishVerification } from '@/backend/integrations/publish-verification';
import { toSignedPublicUrl } from '@/app/api/publish/dispatch/handler';
import { pool } from '@/lib/db';

type InstagramPublishBody = {
  caption?: string;
};

async function readBody(req: Request): Promise<InstagramPublishBody> {
  try {
    return (await req.json()) as InstagramPublishBody;
  } catch {
    return {};
  }
}

function instagramPermalink(platformPostId: string): string | null {
  // IG platform_post_id for feed posts is the media ID; construct a best-effort
  // permalink. The canonical permalink is only available via IG API after publish.
  if (!platformPostId || platformPostId.includes('_')) {
    return `https://www.instagram.com/`;
  }
  return `https://www.instagram.com/p/${encodeURIComponent(platformPostId)}/`;
}

export async function handleInstagramPublish(req: Request, jobId: string) {
  const tenantResult = await loadTenantContextOrResponse();
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantId } = tenantResult.tenantContext;

  const runtimeDoc = await loadMarketingJobRuntime(jobId);
  if (!runtimeDoc || runtimeDoc.tenant_id !== tenantId) {
    return new Response(
      JSON.stringify({ error: 'Job not found.', reason: 'job_not_found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  const body = await readBody(req);

  // Resolve caption: caller-provided takes precedence, then social-copy.json instagram_feed
  let caption = typeof body.caption === 'string' ? body.caption.trim() : '';
  if (!caption) {
    try {
      const socialCopy = await loadSocialCopyArtifact(jobId);
      if (socialCopy) {
        const igPost = socialCopy.posts.find((p) => p.channel === 'instagram_feed');
        if (igPost) {
          const hashtags = igPost.hashtags.length > 0 ? `\n\n${igPost.hashtags.join(' ')}` : '';
          caption = `${igPost.caption}${hashtags}`;
        }
      }
    } catch {
      // Non-fatal: proceed without caption if social-copy.json is unavailable
    }
  }

  // Find approved image from creative review
  let mediaUrl: string | null = null;
  try {
    const workspaceView = await buildCampaignWorkspaceView(jobId);
    const approvedAssets = workspaceView.creativeReview?.assets.filter(
      (a) => a.status === 'approved' && (a.contentType?.startsWith('image/') || a.contentType === null),
    ) ?? [];

    // Prefer the fullPreviewUrl; fall back to previewUrl
    for (const asset of approvedAssets) {
      const url = asset.fullPreviewUrl || asset.previewUrl;
      if (url) {
        mediaUrl = url;
        break;
      }
    }
  } catch {
    // Non-fatal: proceed without media (caption-only post)
  }

  // Validate and consume the approval record before any side-effects.
  // Per-platform consumption: each platform independently claims the approval via consumed_platforms[].
  // The record is only flipped to 'consumed' once all configured platforms have published.
  const PLATFORM_KEY = 'instagram';
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

  // Sign the media URL into a public proxy URL
  const signedMediaUrls: string[] = [];
  if (mediaUrl) {
    const basename = path.basename(mediaUrl);
    if (basename && !basename.includes('..')) {
      signedMediaUrls.push(toSignedPublicUrl(mediaUrl, tenantId, basename));
    }
  }

  if (!caption && signedMediaUrls.length === 0) {
    return new Response(
      JSON.stringify({ status: 'error', reason: 'no_content', message: 'Neither caption nor approved image is available for this job.' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    );
  }

  try {
    if (!isMetaProvider('instagram')) {
      return new Response(
        JSON.stringify({ status: 'error', reason: 'provider_unavailable', message: 'Instagram provider is not available.' }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    }

    const published = await publishToMetaGraph({
      tenantId,
      provider: 'instagram',
      content: caption,
      mediaUrls: signedMediaUrls,
      scheduledFor: null,
    });

    const verification = await runPublishVerification({
      tenantId,
      provider: published.provider,
      caption,
      primaryOutput: { platform_post_id: published.platformPostId },
      pool,
      jobId,
      idempotencyKey: `${jobId}:publish:instagram:1`,
    });

    const permalink = instagramPermalink(published.platformPostId);

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
    if (error instanceof MetaPublishError) {
      return new Response(
        JSON.stringify({
          status: 'error',
          code: error.code,
          reason: error.code,
          message: error.message,
          retryable: error.retryable,
          retryAfterSeconds: error.retryable ? 60 : null,
        }),
        { status: error.status, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        status: 'error',
        code: 'publish_failed',
        reason: 'publish_failed',
        message: String((error as Error).message || error),
        retryable: false,
        retryAfterSeconds: null,
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}
