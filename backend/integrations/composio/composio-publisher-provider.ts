/**
 * Composio PublisherProvider (Phase 7).
 *
 * Hard rules enforced here:
 *  - Ads/campaigns are ALWAYS created PAUSED/draft. publishAd forces a PAUSED
 *    status argument and never reports anything but `paused`/`draft`.
 *  - Organic posts support dry-run-first (no side effect) and refuse a live
 *    post unless `approved: true` was set by an already-cleared Aries approval.
 *  - Operations whose action slug is not configured are refused with a clear
 *    capability error — never executed against a guessed slug.
 */

import type { PublisherProvider } from '../providers/interfaces';
import {
  isIntegrationPlatform,
  type GetPublishStatusInput,
  type IntegrationPlatform,
  type PublishAdInput,
  type PublishPostInput,
  type PublishResult,
  type UploadMediaInput,
  type UploadMediaResult,
} from '../providers/types';
import { PublishGuardError } from '../providers/errors';
import { redditTargetSubreddit } from '../providers/integration-config';
import type { ComposioConfig, ComposioOperation } from './composio-config';
import type { ComposioFileDescriptor, ComposioGateway } from './composio-client';
import { getConnectionRow, type Queryable } from './connection-store';
import {
  ComposioCapabilityMissingError,
  ComposioConnectionMissingError,
  ComposioToolError,
} from './errors';
import { resolveFacebookManagedPage } from './facebook-page-resolver';
import pool from '@/lib/db';

function pickId(data: unknown, keys: string[]): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  // Some tools nest the payload under data/response/result, and Reddit nests the
  // created object under `json` (data.json.data.name → the t3_ fullname).
  for (const nestKey of ['data', 'response', 'result', 'json']) {
    const nested = obj[nestKey];
    if (nested && typeof nested === 'object') {
      const found = pickId(nested, keys);
      if (found) return found;
    }
  }
  return null;
}

function pickUrl(data: unknown): string | null {
  return pickId(data, ['permalink', 'permalink_url', 'url', 'link']);
}

/** The id keys used for the shared post-id extraction unless a branch overrides. */
const DEFAULT_POST_ID_KEYS = ['post_id', 'id', 'media_id'];

const REDDIT_TITLE_MAX = 300;
const REDDIT_FALLBACK_TITLE = 'New post';

/**
 * Reddit requires a non-empty `title` (it rejects an empty one) ≤ 300 chars. Take
 * the first non-empty line of the post content, collapse internal whitespace, and
 * truncate with an ellipsis. Falls back to a stable label when content is empty.
 * Pure — no I/O — so it is trivially unit-testable.
 */
function redditTitleFromContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const collapsed = (firstLine ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return REDDIT_FALLBACK_TITLE;
  if (collapsed.length <= REDDIT_TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, REDDIT_TITLE_MAX - 1)}…`;
}

export class ComposioPublisherProvider implements PublisherProvider {
  readonly kind = 'composio' as const;

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly db: Queryable = pool,
  ) {}

  supports(platform: IntegrationPlatform): boolean {
    return isIntegrationPlatform(platform);
  }

  private async requireActiveConnection(input: { tenantId: string; platform: IntegrationPlatform }) {
    const conn = await getConnectionRow(input.tenantId, input.platform, this.db);
    if (!conn || conn.status !== 'connected' || !conn.connectedAccountId) {
      throw new ComposioConnectionMissingError(input.platform);
    }
    return conn;
  }

  private requireSlug(platform: IntegrationPlatform, op: ComposioOperation, capability: string): string {
    const slug = this.config.actionSlugFor(platform, op);
    if (!slug) throw new ComposioCapabilityMissingError(platform, capability);
    return slug;
  }

  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    // Dry-run never touches Composio.
    if (input.dryRun) {
      return {
        provider: 'composio',
        platform: input.platform,
        externalPostId: null,
        externalCampaignId: null,
        externalAdId: null,
        status: 'preview',
        url: null,
        rawResponse: {
          previewed: true,
          platform: input.platform,
          mediaCount: input.mediaUrls.length,
          hasCaption: input.content.trim().length > 0,
        },
      };
    }
    if (!input.approved) throw new PublishGuardError();

    const conn = await this.requireActiveConnection({ tenantId: input.tenantId, platform: input.platform });

    // ── Action slug + argument selection (#627) ────────────────────────────
    //
    // Facebook has two distinct action slugs with incompatible parameter schemas:
    //
    //   FACEBOOK_CREATE_PHOTO_POST (`upload_media` op slot)
    //     Required: url (signed public image URL), message, page_id
    //     Used for: image posts (mediaUrls.length > 0)
    //     FACEBOOK_CREATE_POST ignores media_urls entirely, so image posts MUST
    //     route here — confirmed live via FACEBOOK_GET_POST (full_picture present).
    //
    //   FACEBOOK_CREATE_POST (`publish_post` op slot)
    //     Required: message, page_id
    //     Used for: text/link-only posts (no media)
    //
    // Instagram: single `publish_post` slug via caption + media_urls + placement.
    //
    // The page_id for Facebook is stored at connect-time in
    // connected_accounts.external_account_id. When null (OAuth callback race),
    // resolveFacebookManagedPage is called as a fallback.
    let slug: string;
    let toolArgs: Record<string, unknown>;
    // The created post id lives at different keys per platform; a branch may
    // override before the shared extraction at the end of publishPost.
    let idKeys = DEFAULT_POST_ID_KEYS;

    if (input.platform === 'facebook') {
      let pageId = conn.externalAccountId ?? null;
      if (!pageId) {
        const page = await resolveFacebookManagedPage(
          this.gateway,
          this.config,
          conn.connectedAccountId!,
        );
        pageId = page?.pageId ?? null;
      }
      if (!pageId) {
        throw new ComposioCapabilityMissingError(
          'facebook',
          'identify the posting Page — reconnect your Facebook account to resolve this',
        );
      }

      const hasImage = input.mediaUrls.length > 0;
      if (hasImage) {
        // Photo post: FACEBOOK_CREATE_PHOTO_POST via the `upload_media` op slot
        // (COMPOSIO_FACEBOOK_UPLOAD_MEDIA_ACTION=FACEBOOK_CREATE_PHOTO_POST).
        // Only the first image is posted; multi-image carousel is a future feature.
        slug = this.requireSlug(input.platform, 'upload_media', 'publish photo posts');
        toolArgs = {
          url: input.mediaUrls[0],
          message: input.content,
          page_id: pageId,
          ...(input.scheduledFor ? { scheduled_publish_time: input.scheduledFor } : {}),
        };
      } else {
        // Text-only post: FACEBOOK_CREATE_POST via the `publish_post` op slot.
        slug = this.requireSlug(input.platform, 'publish_post', 'publish posts');
        toolArgs = {
          message: input.content,
          page_id: pageId,
          ...(input.scheduledFor ? { scheduled_publish_time: input.scheduledFor } : {}),
        };
      }
    } else if (input.platform === 'x') {
      // X (Twitter): a text post, optionally with a single image. Unlike
      // Facebook's photo post (which accepts an image URL), TWITTER_UPLOAD_MEDIA's
      // `media` is a `file_uploadable` field that needs a staged S3 descriptor —
      // the gateway constructs the SDK WITHOUT auto-upload, so a raw URL would be
      // rejected ("Following fields are missing: {'media'}"). An image post is
      // therefore a pre-publish UPLOAD (stage bytes → register the Twitter media)
      // followed by the create-post call.
      //
      // The whole upload runs BEFORE any tweet exists, so every failure here is
      // surfaced as a ComposioToolError → the dispatcher classifies it
      // definitely-never-posted (safe to roll back the claim + retry). ONLY the
      // final TWITTER_CREATION_OF_A_POST executed via the shared call below is the
      // outcome-unknown boundary (a transport drop after that may have posted).
      //
      // X has no Page-id (resolves through the default connectedAccountId path)
      // and no native scheduling here, so `scheduledFor` is ignored and the
      // status resolves to `published`.
      let mediaId: string | null = null;
      if (input.mediaUrls.length > 0) {
        const uploadSlug = this.requireSlug(input.platform, 'upload_media', 'upload media for X posts');
        const toolkitSlug = this.config.toolkitSlugFor(input.platform);
        let descriptor: ComposioFileDescriptor;
        try {
          descriptor = await this.gateway.uploadFile({
            file: input.mediaUrls[0],
            toolSlug: uploadSlug,
            toolkitSlug,
          });
        } catch (error) {
          // Staging to S3 never created a tweet — definitely-never-posted.
          throw new ComposioToolError(
            uploadSlug,
            error instanceof Error ? error.message : 'failed to stage media for upload',
          );
        }
        const uploaded = await this.gateway.executeTool(uploadSlug, {
          connectedAccountId: conn.connectedAccountId!,
          arguments: { media: descriptor, media_category: 'tweet_image' },
        });
        if (!uploaded.successful) {
          throw new ComposioToolError(uploadSlug, uploaded.error ?? 'media upload reported unsuccessful');
        }
        // The Twitter media id comes back nested (commonly data.data.id) and must
        // be a numeric-string for media_media_ids; never use media_key.
        mediaId = pickId(uploaded.data, ['media_id_string', 'media_id', 'id']);
        if (!mediaId) {
          throw new ComposioToolError(uploadSlug, 'media upload returned no media id');
        }
      }
      slug = this.requireSlug(input.platform, 'publish_post', 'publish posts');
      toolArgs = {
        text: input.content,
        ...(mediaId ? { media_media_ids: [mediaId] } : {}),
      };
    } else if (input.platform === 'reddit') {
      // Reddit: a SINGLE REDDIT_CREATE_REDDIT_POST call. There is NO media-upload
      // action — an image is posted as a `kind='link'` whose url IS the image
      // (Reddit fetches it), never a pre-staged upload. So unlike X, there is no
      // pre-publish step: this is exactly the FB-style single-call,
      // outcome-unknown boundary (a transport drop after dispatch may have
      // posted). Every PRE-call failure here (no subreddit, no slug, no
      // connection) throws BEFORE the shared executeTool below → classified
      // definitely-never-posted → safe rollback + worker re-claim. Reddit is
      // rate-limited and posts can be silently automod-removed; we deliberately
      // do NOT retry-loop a create — a rate-limited create surfaces as
      // never-posted and the standing worker re-claims the row.
      //
      // Subreddit target (never guessed): an explicit
      // COMPOSIO_REDDIT_TARGET_SUBREDDIT, else the connected user's own profile
      // (`u_<username>` self-post), else refuse with a capability error.
      let subreddit = redditTargetSubreddit();
      if (!subreddit && conn.externalAccountName) {
        subreddit = `u_${conn.externalAccountName}`;
      }
      if (!subreddit) {
        throw new ComposioCapabilityMissingError(
          'reddit',
          'configure a target subreddit (COMPOSIO_REDDIT_TARGET_SUBREDDIT) or reconnect Reddit',
        );
      }

      slug = this.requireSlug(input.platform, 'publish_post', 'publish posts');
      // Reddit returns a fullname id (`t3_<base36>`) at data.json.data.name — NOT
      // in the shared default keys (and under a `json` nest), so override here.
      idKeys = ['name', 'id', 'post_id'];

      const title = redditTitleFromContent(input.content);
      const flairId = process.env.COMPOSIO_REDDIT_FLAIR_ID?.trim();
      if (input.mediaUrls.length > 0) {
        // Image post: the image IS the link target (kind='link'); not dropped,
        // not pre-uploaded.
        toolArgs = {
          subreddit,
          title,
          kind: 'link',
          url: input.mediaUrls[0],
          ...(flairId ? { flair_id: flairId } : {}),
        };
      } else {
        // Text post: kind='self' with the body as `text`.
        toolArgs = {
          subreddit,
          title,
          kind: 'self',
          text: input.content,
          ...(flairId ? { flair_id: flairId } : {}),
        };
      }
    } else {
      // Instagram: caption + media_urls + placement + media_type (unchanged).
      slug = this.requireSlug(input.platform, 'publish_post', 'publish posts');
      toolArgs = {
        caption: input.content,
        media_urls: input.mediaUrls,
        placement: input.placement ?? 'feed',
        media_type: input.mediaType ?? 'image',
        ...(input.scheduledFor ? { scheduled_publish_time: input.scheduledFor } : {}),
      };
    }

    const result = await this.gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId!,
      arguments: toolArgs,
    });

    if (!result.successful) {
      throw new ComposioToolError(slug, result.error ?? 'tool reported unsuccessful');
    }

    return {
      provider: 'composio',
      platform: input.platform,
      externalPostId: pickId(result.data, idKeys),
      externalCampaignId: null,
      externalAdId: null,
      status: input.scheduledFor ? 'scheduled' : 'published',
      url: pickUrl(result.data),
      rawResponse: result.data,
    };
  }

  async publishAd(input: PublishAdInput): Promise<PublishResult> {
    const conn = await this.requireActiveConnection({ tenantId: input.tenantId, platform: input.platform });
    const slug = this.requireSlug(input.platform, 'create_ad', 'create ads');

    const result = await this.gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId!,
      arguments: {
        name: input.name,
        ad_account_id: input.adAccountId,
        campaign: input.campaign,
        ad_set: input.adSet,
        creative: input.creative,
        // Non-negotiable: never create an active ad. Force PAUSED on every axis
        // a Meta-family tool might read.
        status: 'PAUSED',
        effective_status: 'PAUSED',
        campaign_status: 'PAUSED',
        adset_status: 'PAUSED',
      },
    });

    if (!result.successful) {
      throw new ComposioToolError(slug, result.error ?? 'tool reported unsuccessful');
    }

    return {
      provider: 'composio',
      platform: input.platform,
      externalPostId: null,
      externalCampaignId: pickId(result.data, ['campaign_id', 'campaignId']),
      externalAdId: pickId(result.data, ['ad_id', 'adId', 'id']),
      // Created PAUSED — surfaced as `paused`, never `published`.
      status: 'paused',
      url: pickUrl(result.data),
      rawResponse: result.data,
    };
  }

  async uploadMedia(input: UploadMediaInput): Promise<UploadMediaResult> {
    const conn = await this.requireActiveConnection({ tenantId: input.tenantId, platform: input.platform });
    const slug = this.config.actionSlugFor(input.platform, 'upload_media');
    if (!slug) {
      // No standalone upload configured: report a no-op preview rather than
      // guessing a slug. Inline upload happens during publishPost where supported.
      return {
        provider: 'composio',
        platform: input.platform,
        mediaHandle: null,
        status: 'preview',
        rawResponse: { reason: `No upload_media action configured for ${input.platform}.` },
      };
    }
    const result = await this.gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId!,
      arguments: { media_url: input.mediaUrl, media_type: input.mediaType },
    });
    if (!result.successful) throw new ComposioToolError(slug, result.error ?? 'tool reported unsuccessful');
    return {
      provider: 'composio',
      platform: input.platform,
      mediaHandle: pickId(result.data, ['media_id', 'id', 'handle', 'creation_id']),
      status: 'uploaded',
      rawResponse: result.data,
    };
  }

  async getPublishStatus(input: GetPublishStatusInput): Promise<PublishResult> {
    return {
      provider: 'composio',
      platform: input.platform,
      externalPostId: input.externalPostId ?? null,
      externalCampaignId: null,
      externalAdId: input.externalAdId ?? null,
      status: 'pending',
      url: null,
      rawResponse: { reason: 'Status polling is read from analytics; no dedicated status tool configured.' },
    };
  }
}
