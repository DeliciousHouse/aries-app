/**
 * Aries-owned provider interfaces.
 *
 * Four seams, each implemented by zero or more concrete providers:
 *   - AccountConnectionProvider — the connect/list/disconnect lifecycle.
 *   - PublisherProvider         — publishing posts/ads/media.
 *   - AnalyticsProvider         — reading normalized insights.
 *   - CapabilityProvider        — what a connection is actually allowed to do.
 *
 * The existing direct Meta path implements the publishing seam (organic posts)
 * via DirectMetaProvider; Composio implements all four behind a feature flag.
 */

import type {
  AccountInsightsInput,
  AdInsightsInput,
  Capabilities,
  ConnectLinkResult,
  ConnectedAccount,
  GetPublishStatusInput,
  IntegrationPlatform,
  NormalizedMetrics,
  PostInsightsInput,
  PublishAdInput,
  PublishPostInput,
  PublishResult,
  RequestedCapability,
  UploadMediaInput,
  UploadMediaResult,
} from './types';

export interface AccountConnectionProvider {
  readonly kind: 'composio' | 'direct_meta';
  createConnectLink(
    externalUserId: string,
    platform: IntegrationPlatform,
    requestedCapability: RequestedCapability,
    options?: { tenantId: string; callbackUrl?: string },
  ): Promise<ConnectLinkResult>;
  listConnections(externalUserId: string, options?: { tenantId: string }): Promise<ConnectedAccount[]>;
  getConnection(
    externalUserId: string,
    platform: IntegrationPlatform,
    options?: { tenantId: string },
  ): Promise<ConnectedAccount | null>;
  disconnectConnection(
    externalUserId: string,
    platform: IntegrationPlatform,
    options?: { tenantId: string },
  ): Promise<{ disconnected: boolean }>;
  refreshConnectionStatus(
    externalUserId: string,
    platform: IntegrationPlatform,
    options?: { tenantId: string },
  ): Promise<ConnectedAccount | null>;
}

export interface PublisherProvider {
  readonly kind: 'composio' | 'direct_meta';
  /** True if this provider can service the given platform at all. */
  supports(platform: IntegrationPlatform): boolean;
  publishPost(input: PublishPostInput): Promise<PublishResult>;
  /** Ads are always created PAUSED/draft. */
  publishAd(input: PublishAdInput): Promise<PublishResult>;
  uploadMedia(input: UploadMediaInput): Promise<UploadMediaResult>;
  getPublishStatus(input: GetPublishStatusInput): Promise<PublishResult>;
}

export interface AnalyticsProvider {
  readonly kind: 'composio' | 'direct_meta';
  supports(platform: IntegrationPlatform): boolean;
  getPostInsights(input: PostInsightsInput): Promise<NormalizedMetrics>;
  getAdInsights(input: AdInsightsInput): Promise<NormalizedMetrics>;
  getAccountInsights(input: AccountInsightsInput): Promise<NormalizedMetrics>;
}

export interface CapabilityProvider {
  readonly kind: 'composio' | 'direct_meta';
  checkCapabilities(
    externalUserId: string,
    platform: IntegrationPlatform,
    options?: { tenantId: string },
  ): Promise<Capabilities>;
}
