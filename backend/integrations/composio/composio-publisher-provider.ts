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
import type { ComposioConfig, ComposioOperation } from './composio-config';
import type { ComposioGateway } from './composio-client';
import { getConnectionRow, type Queryable } from './connection-store';
import {
  ComposioCapabilityMissingError,
  ComposioConnectionMissingError,
  ComposioToolError,
} from './errors';
import pool from '@/lib/db';

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
