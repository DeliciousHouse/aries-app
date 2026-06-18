/**
 * Aries-owned integration abstractions — shared types.
 *
 * These types are the stable, provider-agnostic contract the rest of Aries
 * codes against. Concrete providers (the existing direct Meta path, and the
 * optional Composio adapter) implement the interfaces in this directory and
 * normalize their wire formats into these shapes. Nothing outside the provider
 * implementations should import a vendor SDK type directly.
 *
 * Design rules baked in here (see docs/integrations/composio.md):
 *  - Ads/campaigns are always created PAUSED or draft. There is no "live" ad
 *    status a provider may return on creation.
 *  - Organic posts only go live when an explicit approval has been granted by
 *    the existing Aries approval flow; otherwise the provider must dry-run.
 *  - Missing analytics metrics are `null`, never fabricated. `unavailableReason`
 *    carries the explanation when a platform does not expose a metric.
 *  - Connections persist provider connected-account IDs, never raw OAuth tokens.
 */

/** Platforms Aries can target through a provider. */
export type IntegrationPlatform =
  | 'facebook'
  | 'instagram'
  | 'meta_ads'
  | 'tiktok'
  | 'youtube'
  | 'linkedin'
  | 'reddit'
  | 'x';

export const INTEGRATION_PLATFORMS: readonly IntegrationPlatform[] = [
  'facebook',
  'instagram',
  'meta_ads',
  'tiktok',
  'youtube',
  'linkedin',
  'reddit',
  'x',
] as const;

export function isIntegrationPlatform(value: string): value is IntegrationPlatform {
  return (INTEGRATION_PLATFORMS as readonly string[]).includes(value);
}

/** Which provider serviced (or would service) a given request. */
export type ProviderKind = 'composio' | 'direct_meta' | 'none';

/** Capability the user is asking for when starting a connection. */
export type RequestedCapability = 'publish' | 'analytics' | 'ads' | 'full';

export const REQUESTED_CAPABILITIES: readonly RequestedCapability[] = [
  'publish',
  'analytics',
  'ads',
  'full',
] as const;

export function isRequestedCapability(value: string): value is RequestedCapability {
  return (REQUESTED_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The capability matrix for a connected account. Returned by
 * CapabilityProvider.checkCapabilities and persisted on the connection row so
 * the UI can render status without a live round-trip on every page load.
 */
export interface Capabilities {
  canPublishOrganic: boolean;
  canPublishAds: boolean;
  canReadPostInsights: boolean;
  canReadAdInsights: boolean;
  canUploadMedia: boolean;
  /** Permissions/scopes the platform reports are missing for the above. */
  missingPermissions: string[];
  /** Non-fatal advisories (e.g. "personal profile — connect a Page for posting"). */
  warnings: string[];
  provider: ProviderKind;
}

export function emptyCapabilities(provider: ProviderKind): Capabilities {
  return {
    canPublishOrganic: false,
    canPublishAds: false,
    canReadPostInsights: false,
    canReadAdInsights: false,
    canUploadMedia: false,
    missingPermissions: [],
    warnings: [],
    provider,
  };
}

/** Lifecycle status of a stored connection, normalized across providers. */
export type ConnectionStatus =
  | 'not_connected'
  | 'pending'
  | 'connected'
  | 'reauthorization_required'
  | 'error';

/**
 * A connected social/ad account as Aries stores it. Note the deliberate
 * absence of any access-token / refresh-token field: Aries stores the
 * provider's connected-account ID and lets the provider hold the secret.
 */
export interface ConnectedAccount {
  id: string;
  tenantId: string;
  /** Stable per-user identifier handed to the provider (Composio userId). */
  externalUserId: string;
  platform: IntegrationPlatform;
  provider: ProviderKind;
  /** Composio connected-account ID (the thing we persist instead of tokens). */
  connectedAccountId: string | null;
  authConfigId: string | null;
  /** The platform-side account/page/channel id once selected. */
  externalAccountId: string | null;
  externalAccountName: string | null;
  status: ConnectionStatus;
  capabilities: Capabilities | null;
  lastCapabilityCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Result of starting a connection — the URL to send the user to. */
export interface ConnectLinkResult {
  provider: ProviderKind;
  platform: IntegrationPlatform;
  connectUrl: string;
  /** Provider-side connection-request id, persisted to reconcile the callback. */
  connectionRequestId: string | null;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export type PublishPlacement = 'feed' | 'story' | 'reel';
export type PublishMediaType = 'image' | 'video';

/**
 * Normalized status a publish can resolve to. `paused` / `draft` are the only
 * states an ad/campaign creation may report (constraint: never auto-activate).
 * `preview` is a dry-run that performed no side effect.
 */
export type PublishStatus =
  | 'preview'
  | 'draft'
  | 'paused'
  | 'scheduled'
  | 'published'
  | 'pending'
  | 'failed';

export interface PublishPostInput {
  tenantId: string;
  externalUserId?: string;
  platform: IntegrationPlatform;
  content: string;
  mediaUrls: string[];
  placement?: PublishPlacement;
  mediaType?: PublishMediaType;
  scheduledFor?: string | null;
  /**
   * When true, perform no live side effect — validate and return a `preview`
   * result. Organic publishing must support dry-run-first.
   */
  dryRun?: boolean;
  /**
   * Must be true for a live (non-dry-run) post. Set only by callers that have
   * already cleared the existing Aries approval flow. A provider MUST refuse a
   * live post when this is not true.
   */
  approved?: boolean;
}

export interface PublishAdInput {
  tenantId: string;
  externalUserId?: string;
  platform: IntegrationPlatform;
  /** Ad creative + targeting, provider-normalized upstream. */
  name: string;
  adAccountId?: string;
  campaign?: Record<string, unknown>;
  adSet?: Record<string, unknown>;
  creative?: Record<string, unknown>;
  /**
   * Always treated as PAUSED/draft regardless of this hint; present only so
   * callers can be explicit. A provider must never create an ACTIVE ad.
   */
  dryRun?: boolean;
}

export interface UploadMediaInput {
  tenantId: string;
  externalUserId?: string;
  platform: IntegrationPlatform;
  mediaUrl: string;
  mediaType: PublishMediaType;
}

export interface GetPublishStatusInput {
  tenantId: string;
  externalUserId?: string;
  platform: IntegrationPlatform;
  externalPostId?: string;
  externalAdId?: string;
}

/** Normalized publish result returned by every PublisherProvider method. */
export interface PublishResult {
  provider: ProviderKind;
  platform: IntegrationPlatform;
  externalPostId: string | null;
  externalCampaignId: string | null;
  externalAdId: string | null;
  status: PublishStatus;
  url: string | null;
  rawResponse: unknown;
}

export interface UploadMediaResult {
  provider: ProviderKind;
  platform: IntegrationPlatform;
  mediaHandle: string | null;
  status: 'uploaded' | 'preview' | 'failed';
  rawResponse: unknown;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface PostInsightsInput {
  tenantId: string;
  externalUserId?: string;
  platform: IntegrationPlatform;
  externalPostId: string;
}

export interface AdInsightsInput {
  tenantId: string;
  externalUserId?: string;
  platform: IntegrationPlatform;
  externalAdId?: string;
  externalCampaignId?: string;
}

export interface AccountInsightsInput {
  tenantId: string;
  externalUserId?: string;
  platform: IntegrationPlatform;
  /** ISO date window. */
  since?: string;
  until?: string;
}

/**
 * Normalized metric envelope. Every numeric field is `number | null`; a `null`
 * means "this platform/provider did not report this metric" — it is NEVER a
 * fabricated zero. `rawMetrics` keeps the untouched provider payload for
 * debugging, and `unavailableReason` explains a wholesale gap.
 */
export interface NormalizedMetrics {
  platform: IntegrationPlatform;
  externalPostId: string | null;
  externalAdId: string | null;
  publishedAt: string | null;
  impressions: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
  spend: number | null;
  cpm: number | null;
  cpc: number | null;
  ctr: number | null;
  conversions: number | null;
  costPerResult: number | null;
  revenue: number | null;
  roas: number | null;
  rawMetrics: unknown;
  /** Set when a metric set cannot be retrieved at all (e.g. missing scope). */
  unavailableReason?: string | null;
}

/** Build an all-null metric envelope, optionally with an unavailable reason. */
export function emptyMetrics(
  platform: IntegrationPlatform,
  opts?: { externalPostId?: string | null; externalAdId?: string | null; unavailableReason?: string | null },
): NormalizedMetrics {
  return {
    platform,
    externalPostId: opts?.externalPostId ?? null,
    externalAdId: opts?.externalAdId ?? null,
    publishedAt: null,
    impressions: null,
    reach: null,
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    clicks: null,
    spend: null,
    cpm: null,
    cpc: null,
    ctr: null,
    conversions: null,
    costPerResult: null,
    revenue: null,
    roas: null,
    rawMetrics: null,
    unavailableReason: opts?.unavailableReason ?? null,
  };
}
