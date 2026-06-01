/**
 * `auto`-mode composite providers: try Composio first, fall back to the direct
 * Meta provider when Composio cannot service a platform or throws.
 *
 * The fallback is deliberately conservative: it only kicks in when the direct
 * provider actually supports the platform (i.e. Facebook/Instagram). For a
 * platform only Composio can reach (TikTok, YouTube, LinkedIn, Reddit, Meta
 * Ads) a Composio failure surfaces as-is — there is nothing to fall back to.
 */

import type { AnalyticsProvider, PublisherProvider } from './interfaces';
import type {
  AdInsightsInput,
  AccountInsightsInput,
  GetPublishStatusInput,
  IntegrationPlatform,
  NormalizedMetrics,
  PostInsightsInput,
  PublishAdInput,
  PublishPostInput,
  PublishResult,
  UploadMediaInput,
  UploadMediaResult,
} from './types';

function logFallback(scope: string, platform: IntegrationPlatform, error: unknown): void {
  // Mirrors the repo's lightweight console diagnostics; no PII, just the seam.
  console.warn(
    `[integrations:auto] composio ${scope} failed for ${platform}; falling back to direct_meta:`,
    error instanceof Error ? error.message : String(error),
  );
}

export class AutoPublisherProvider implements PublisherProvider {
  readonly kind = 'composio' as const;
  constructor(
    private readonly composio: PublisherProvider,
    private readonly direct: PublisherProvider,
  ) {}

  supports(platform: IntegrationPlatform): boolean {
    return this.composio.supports(platform) || this.direct.supports(platform);
  }

  async publishPost(input: PublishPostInput): Promise<PublishResult> {
    if (this.composio.supports(input.platform)) {
      try {
        return await this.composio.publishPost(input);
      } catch (error) {
        if (!this.direct.supports(input.platform)) throw error;
        logFallback('publishPost', input.platform, error);
      }
    }
    return this.direct.publishPost(input);
  }

  async publishAd(input: PublishAdInput): Promise<PublishResult> {
    if (this.composio.supports(input.platform)) {
      try {
        return await this.composio.publishAd(input);
      } catch (error) {
        if (!this.direct.supports(input.platform)) throw error;
        logFallback('publishAd', input.platform, error);
      }
    }
    return this.direct.publishAd(input);
  }

  async uploadMedia(input: UploadMediaInput): Promise<UploadMediaResult> {
    if (this.composio.supports(input.platform)) {
      try {
        return await this.composio.uploadMedia(input);
      } catch (error) {
        if (!this.direct.supports(input.platform)) throw error;
        logFallback('uploadMedia', input.platform, error);
      }
    }
    return this.direct.uploadMedia(input);
  }

  async getPublishStatus(input: GetPublishStatusInput): Promise<PublishResult> {
    if (this.composio.supports(input.platform)) {
      try {
        return await this.composio.getPublishStatus(input);
      } catch (error) {
        if (!this.direct.supports(input.platform)) throw error;
        logFallback('getPublishStatus', input.platform, error);
      }
    }
    return this.direct.getPublishStatus(input);
  }
}

export class AutoAnalyticsProvider implements AnalyticsProvider {
  readonly kind = 'composio' as const;
  constructor(
    private readonly composio: AnalyticsProvider,
    private readonly direct: AnalyticsProvider,
  ) {}

  supports(platform: IntegrationPlatform): boolean {
    return this.composio.supports(platform) || this.direct.supports(platform);
  }

  async getPostInsights(input: PostInsightsInput): Promise<NormalizedMetrics> {
    if (this.composio.supports(input.platform)) {
      try {
        return await this.composio.getPostInsights(input);
      } catch (error) {
        if (!this.direct.supports(input.platform)) throw error;
        logFallback('getPostInsights', input.platform, error);
      }
    }
    return this.direct.getPostInsights(input);
  }

  async getAdInsights(input: AdInsightsInput): Promise<NormalizedMetrics> {
    if (this.composio.supports(input.platform)) {
      try {
        return await this.composio.getAdInsights(input);
      } catch (error) {
        if (!this.direct.supports(input.platform)) throw error;
        logFallback('getAdInsights', input.platform, error);
      }
    }
    return this.direct.getAdInsights(input);
  }

  async getAccountInsights(input: AccountInsightsInput): Promise<NormalizedMetrics> {
    if (this.composio.supports(input.platform)) {
      try {
        return await this.composio.getAccountInsights(input);
      } catch (error) {
        if (!this.direct.supports(input.platform)) throw error;
        logFallback('getAccountInsights', input.platform, error);
      }
    }
    return this.direct.getAccountInsights(input);
  }
}
