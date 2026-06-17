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
  type ConnectedAccount,
  type GetPublishStatusInput,
  type IntegrationPlatform,
  type PublishAdInput,
  type PublishPostInput,
  type PublishResult,
  type UploadMediaInput,
  type UploadMediaResult,
} from '../providers/types';
import { PublishGuardError } from '../providers/errors';
import type { ComposioConfig, ComposioOperation } from './composio-config';
import type { ComposioGateway } from './composio-client';
import { getConnectionRow, type Queryable } from './connection-store';
import { resolveFacebookManagedPage } from './facebook-page-resolver';
import {
  ComposioCapabilityMissingError,
  ComposioConnectionMissingError,
  ComposioToolError,
} from './errors';
import pool from '@/lib/db';

/**
 * Verified Composio Facebook publish slugs (env-overridable via the publish_post
 * / upload_media ops). FACEBOOK_CREATE_POST is text/link only; image posts MUST
 * use FACEBOOK_CREATE_PHOTO_POST. Both require `page_id` + (`message` / `url`).
 */
const DEFAULT_FB_TEXT_POST_SLUG = 'FACEBOOK_CREATE_POST';
const DEFAULT_FB_PHOTO_POST_SLUG = 'FACEBOOK_CREATE_PHOTO_POST';

/** FB wants a future UTC epoch in SECONDS for scheduled posts. */
function toUnixSecondsOrUndefined(iso?: string | null): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

function pickId(data: unknown, keys: string[]): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  // Some tools nest the payload under data/response.
  for (const nestKey of ['data', 'response', 'result']) {
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

    // Facebook needs the Graph-native arg shape: `message` (not text/caption) +
    // `page_id`, and the photo action (`url`) for image posts. The generic shape
    // below is rejected ("Following fields are missing: {'message','page_id'}").
    if (input.platform === 'facebook') {
      return this.publishFacebookPost(input, conn);
    }

    // Instagram / other platforms: unchanged generic arg shape.
    const slug = this.requireSlug(input.platform, 'publish_post', 'publish posts');

    const result = await this.gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId!,
      arguments: {
        text: input.content,
        caption: input.content,
        media_urls: input.mediaUrls,
        placement: input.placement ?? 'feed',
        media_type: input.mediaType ?? 'image',
        ...(input.scheduledFor ? { scheduled_publish_time: input.scheduledFor } : {}),
      },
    });

    if (!result.successful) {
      throw new ComposioToolError(slug, result.error ?? 'tool reported unsuccessful');
    }

    return {
      provider: 'composio',
      platform: input.platform,
      externalPostId: pickId(result.data, ['post_id', 'id', 'media_id']),
      externalCampaignId: null,
      externalAdId: null,
      status: input.scheduledFor ? 'scheduled' : 'published',
      url: pickUrl(result.data),
      rawResponse: result.data,
    };
  }

  /**
   * Resolve the Facebook Page id for publishing: the connection's
   * external_account_id, else resolve it from Composio (FACEBOOK_LIST_MANAGED_PAGES)
   * and back-heal connected_accounts so future publishes skip the lookup.
   * Throws ComposioToolError (definitely-never-posted) when it cannot be resolved.
   */
  private async resolveFacebookPageId(conn: ConnectedAccount): Promise<string> {
    const existing = conn.externalAccountId?.trim();
    if (existing) return existing;

    if (!conn.connectedAccountId) {
      throw new ComposioToolError(
        DEFAULT_FB_TEXT_POST_SLUG,
        'No connected account id available to resolve the Facebook page id for publishing.',
      );
    }
    const page = await resolveFacebookManagedPage(this.gateway, this.config, conn.connectedAccountId);
    if (!page) {
      throw new ComposioToolError(
        'FACEBOOK_LIST_MANAGED_PAGES',
        'Could not resolve a managed Facebook page id for publishing.',
      );
    }
    // Best-effort back-heal so subsequent publishes skip resolution.
    try {
      await this.db.query(
        `UPDATE connected_accounts
           SET external_account_id = $1,
               external_account_name = COALESCE($2, external_account_name),
               updated_at = now()
         WHERE tenant_id = $3 AND platform = 'facebook'`,
        [page.pageId, page.pageName, conn.tenantId],
      );
    } catch {
      // non-fatal — we still have the resolved page id for this publish
    }
    return page.pageId;
  }

  private async publishFacebookPost(input: PublishPostInput, conn: ConnectedAccount): Promise<PublishResult> {
    const pageId = await this.resolveFacebookPageId(conn);
    const scheduledAt = toUnixSecondsOrUndefined(input.scheduledFor);
    const scheduled = scheduledAt !== undefined;
    const scheduleArgs = scheduled ? { published: false, scheduled_publish_time: scheduledAt } : {};

    const hasMedia = input.mediaUrls.length > 0;
    // Image post -> FACEBOOK_CREATE_PHOTO_POST (page_id + url + message); text/link
    // post -> FACEBOOK_CREATE_POST (page_id + message). Verified slugs are the
    // defaults so publishing works even when the *_ACTION env vars are unset; an
    // env override (upload_media / publish_post) still wins.
    const slug = hasMedia
      ? this.config.actionSlugFor('facebook', 'upload_media') ?? DEFAULT_FB_PHOTO_POST_SLUG
      : this.config.actionSlugFor('facebook', 'publish_post') ?? DEFAULT_FB_TEXT_POST_SLUG;

    const args: Record<string, unknown> = {
      page_id: pageId,
      message: input.content,
      ...(hasMedia ? { url: input.mediaUrls[0] } : {}),
      ...scheduleArgs,
    };

    const result = await this.gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId!,
      arguments: args,
    });

    if (!result.successful) {
      throw new ComposioToolError(slug, result.error ?? 'tool reported unsuccessful');
    }

    return {
      provider: 'composio',
      platform: 'facebook',
      externalPostId: pickId(result.data, ['post_id', 'id', 'media_id']),
      externalCampaignId: null,
      externalAdId: null,
      status: scheduled ? 'scheduled' : 'published',
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
    // Facebook's photo action (FACEBOOK_CREATE_PHOTO_POST) requires page_id + url;
    // other platforms keep the generic media_url/media_type shape.
    const args =
      input.platform === 'facebook'
        ? { page_id: await this.resolveFacebookPageId(conn), url: input.mediaUrl }
        : { media_url: input.mediaUrl, media_type: input.mediaType };
    const result = await this.gateway.executeTool(slug, {
      connectedAccountId: conn.connectedAccountId!,
      arguments: args,
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
