/**
 * DirectMetaProvider — a thin adapter that wraps the EXISTING direct Meta path
 * (backend/integrations/meta-publishing.ts) behind the Aries provider seams,
 * with identical behavior. It does NOT reimplement publishing; it delegates to
 * `publishToMetaGraph` and normalizes the result.
 *
 * Scope of the existing direct path (confirmed by inspection):
 *  - Organic Facebook + Instagram post publishing (feed/story/reel).
 *  - It does NOT create paid ads/campaigns — that lives in the Hermes pipeline,
 *    which already creates campaigns/ad sets/ads as PAUSED for review. So this
 *    provider reports ads as not-serviceable here and never creates a live ad.
 *  - It has NO insights scopes (see project memory: read_insights /
 *    instagram_manage_insights are not granted), so analytics is reported
 *    unavailable with an explicit reason rather than fabricated.
 *
 * This file adds the wrapper only. meta-publishing.ts is untouched.
 */

import {
  publishToMetaGraph,
  normalizeMetaPlacement,
  normalizeMetaMediaType,
  type MetaPublishSuccess,
} from '../meta-publishing';
import type {
  AnalyticsProvider,
  CapabilityProvider,
  PublisherProvider,
} from '../providers/interfaces';
import {
  emptyCapabilities,
  emptyMetrics,
  type AccountInsightsInput,
  type AdInsightsInput,
  type Capabilities,
  type GetPublishStatusInput,
  type IntegrationPlatform,
  type NormalizedMetrics,
  type PostInsightsInput,
  type PublishAdInput,
  type PublishPostInput,
  type PublishResult,
  type UploadMediaInput,
  type UploadMediaResult,
} from '../providers/types';
import { PublishGuardError } from '../providers/errors';

const DIRECT_ORGANIC_PLATFORMS = new Set<IntegrationPlatform>(['facebook', 'instagram']);

function metaProviderArg(platform: IntegrationPlatform): 'facebook' | 'instagram' {
  return platform === 'instagram' ? 'instagram' : 'facebook';
}

function metaEnvConfigured(): { token: boolean; page: boolean; adAccount: boolean } {
  return {
    token: Boolean(process.env.META_ACCESS_TOKEN?.trim()),
    page: Boolean(process.env.META_PAGE_ID?.trim()),
    adAccount: Boolean(process.env.META_AD_ACCOUNT_ID?.trim()),
  };
}

export class DirectMetaProvider
  implements PublisherProvider, AnalyticsProvider, CapabilityProvider
{
  readonly kind = 'direct_meta' as const;

  supports(platform: IntegrationPlatform): boolean {
    return DIRECT_ORGANIC_PLATFORMS.has(platform);
  }

  // -- PublisherProvider ----------------------------------------------------

  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    if (!this.supports(input.platform)) {
      throw new PublishGuardError(
        `The direct Meta provider only publishes organic Facebook/Instagram posts, not ${input.platform}.`,
      );
    }

    const placement = normalizeMetaPlacement(input.placement);
    const mediaType = normalizeMetaMediaType(input.mediaType);

    // Dry-run: validate the shape but perform NO Graph side effect.
    if (input.dryRun) {
      return {
        provider: 'direct_meta',
        platform: input.platform,
        externalPostId: null,
        externalCampaignId: null,
        externalAdId: null,
        status: 'preview',
        url: null,
        rawResponse: {
          previewed: true,
          platform: input.platform,
          placement,
          mediaType,
          mediaCount: input.mediaUrls.length,
          hasCaption: input.content.trim().length > 0,
        },
      };
    }

    // Live publish gate: never post without an explicit approval.
    if (!input.approved) {
      throw new PublishGuardError();
    }

    const success: MetaPublishSuccess = await publishToMetaGraph({
      tenantId: input.tenantId,
      provider: metaProviderArg(input.platform),
      content: input.content,
      mediaUrls: input.mediaUrls,
      placement,
      mediaType,
      scheduledFor: input.scheduledFor ?? null,
    });

    return {
      provider: 'direct_meta',
      platform: success.provider === 'instagram' ? 'instagram' : 'facebook',
      externalPostId: success.platformPostId,
      externalCampaignId: null,
      externalAdId: null,
      status: success.mode === 'scheduled' ? 'scheduled' : 'published',
      url: null,
      rawResponse: success,
    };
  }

  async publishAd(input: PublishAdInput): Promise<PublishResult> {
    // The direct path does not create paid ads here. Paid campaigns/ad sets/ads
    // are created PAUSED inside the Hermes pipeline. Return a no-op draft so the
    // contract (never a live ad) holds and the caller can see it was not run.
    return {
      provider: 'direct_meta',
      platform: input.platform,
      externalPostId: null,
      externalCampaignId: null,
      externalAdId: null,
      status: 'draft',
      url: null,
      rawResponse: {
        created: false,
        reason:
          'Direct Meta provider does not create paid ads; campaign/ad-set/ad creation (always PAUSED) is owned by the Hermes Stage-4 pipeline.',
      },
    };
  }

  async uploadMedia(input: UploadMediaInput): Promise<UploadMediaResult> {
    // The direct path uploads media inline during publishPost (unpublished
    // /photos then /feed, or an IG container). There is no standalone upload
    // step, so this is a documented no-op preview rather than a side effect.
    return {
      provider: 'direct_meta',
      platform: input.platform,
      mediaHandle: null,
      status: 'preview',
      rawResponse: {
        reason: 'Direct Meta provider uploads media inline during publishPost; no standalone upload is performed.',
      },
    };
  }

  async getPublishStatus(input: GetPublishStatusInput): Promise<PublishResult> {
    // The direct path persists publish state in the `posts` table; it does not
    // re-poll Meta (no insights scopes). Echo the known ids with a pending
    // status rather than inventing a live lookup.
    return {
      provider: 'direct_meta',
      platform: input.platform,
      externalPostId: input.externalPostId ?? null,
      externalCampaignId: null,
      externalAdId: input.externalAdId ?? null,
      status: 'pending',
      url: null,
      rawResponse: {
        reason: 'Direct Meta provider does not poll Meta for status; publish state is tracked in the posts table.',
      },
    };
  }

  // -- AnalyticsProvider ----------------------------------------------------
  // No insights scopes are granted to the direct Meta connection, so every
  // analytics call returns all-null metrics with an explicit unavailable reason
  // (never a fabricated zero).

  private unavailable(platform: IntegrationPlatform, ids?: { externalPostId?: string | null; externalAdId?: string | null }): NormalizedMetrics {
    return emptyMetrics(platform, {
      externalPostId: ids?.externalPostId ?? null,
      externalAdId: ids?.externalAdId ?? null,
      unavailableReason:
        'Direct Meta analytics is unavailable: the Aries Meta connection has no insights scopes (read_insights / instagram_manage_insights). Connect via Composio or grant insights scopes to enable analytics.',
    });
  }

  async getPostInsights(input: PostInsightsInput): Promise<NormalizedMetrics> {
    return this.unavailable(input.platform, { externalPostId: input.externalPostId });
  }

  async getAdInsights(input: AdInsightsInput): Promise<NormalizedMetrics> {
    return this.unavailable(input.platform, { externalAdId: input.externalAdId ?? null });
  }

  async getAccountInsights(input: AccountInsightsInput): Promise<NormalizedMetrics> {
    return this.unavailable(input.platform);
  }

  // -- CapabilityProvider ---------------------------------------------------

  async checkCapabilities(
    _externalUserId: string,
    platform: IntegrationPlatform,
  ): Promise<Capabilities> {
    const caps = emptyCapabilities('direct_meta');
    if (!this.supports(platform)) {
      caps.warnings.push(
        `The direct Meta provider does not service ${platform}. Enable Composio to connect ${platform}.`,
      );
      return caps;
    }
    const env = metaEnvConfigured();
    if (env.token && env.page) {
      caps.canPublishOrganic = true;
      caps.canUploadMedia = true;
    } else {
      caps.missingPermissions.push('META_PAGE_ID', 'META_ACCESS_TOKEN');
      caps.warnings.push('Direct Meta publishing is not configured (META_PAGE_ID / META_ACCESS_TOKEN missing).');
    }
    // Insights are not granted; ads are owned by Hermes, not this provider.
    caps.canReadPostInsights = false;
    caps.canReadAdInsights = false;
    caps.canPublishAds = false;
    caps.missingPermissions.push('read_insights');
    caps.warnings.push(
      'Post/ad insights are unavailable on the direct Meta connection (no insights scopes). Paid ads are created PAUSED by the Hermes pipeline, not this provider.',
    );
    return caps;
  }
}
