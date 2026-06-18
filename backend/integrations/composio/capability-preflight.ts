/**
 * Capability preflight (Phase 6).
 *
 * After a connection is ACTIVE we derive what it can actually do. Capabilities
 * are computed from two honest signals only:
 *   1. Which action slugs the operator has configured for this platform
 *      (an unconfigured operation is reported as unavailable, never assumed).
 *   2. Documented per-platform constraints/warnings (e.g. IG must be a Business
 *      account, Reddit exposes no reach analytics). These are surfaced as
 *      warnings rather than silently granting/denying a capability we cannot
 *      verify without a live, scoped API probe.
 *
 * No capability is fabricated: if we cannot confirm it, it stays false and the
 * reason goes into missingPermissions/warnings.
 */

import {
  emptyCapabilities,
  type Capabilities,
  type IntegrationPlatform,
} from '../providers/types';
import type { ComposioConfig } from './composio-config';
import { getAnalyticsMapper } from './analytics-mappers';

/** Platform-specific advisory warnings from Phase 6 of the integration plan. */
const PLATFORM_WARNINGS: Partial<Record<IntegrationPlatform, string[]>> = {
  facebook: [
    'Confirm a Facebook Page is connected (not just a personal profile) — page posting and insights require a Page.',
  ],
  instagram: [
    'Instagram publishing requires a Business or Creator account linked to a Facebook Page.',
  ],
  meta_ads: [
    'Meta Ads typically requires a custom Composio auth config (the managed app may be unavailable). Confirm ad-account access before publishing.',
  ],
  tiktok: [
    'TikTok deeper analytics may be unavailable; only stats exposed by the connected API will be reported.',
  ],
  youtube: [
    'Deep YouTube Analytics requires the YouTube Analytics API; basic video/channel stats only unless Composio exposes equivalent access.',
  ],
  linkedin: [
    'For business use, connect an Organization Page — personal-profile posting and analytics are limited.',
  ],
  reddit: [
    'Reddit exposes public engagement only; full impressions/reach analytics are unavailable.',
  ],
};


/** The static per-platform connection prerequisites/advisories, available
 *  regardless of connection state so the UI can show them BEFORE connect. */
export function platformPrerequisites(platform: IntegrationPlatform): string[] {
  return PLATFORM_WARNINGS[platform] ?? [];
}

export interface PreflightContext {
  config: ComposioConfig;
  platform: IntegrationPlatform;
  /** Whether a connection row is ACTIVE. */
  active: boolean;
}

export function computeCapabilities(ctx: PreflightContext): Capabilities {
  const caps = emptyCapabilities('composio');

  if (!ctx.active) {
    caps.warnings.push('No active connection — connect the account to enable capabilities.');
    return caps;
  }

  const { config, platform } = ctx;
  const has = (op: Parameters<ComposioConfig['actionSlugFor']>[1]) => config.actionSlugFor(platform, op) !== null;
  // Analytics ships with verified default tool slugs (analytics-mappers), so a
  // capability is available when EITHER a mapper exists OR an env slug is set.
  const canAnalytics = (op: Parameters<ComposioConfig['actionSlugFor']>[1]) =>
    has(op) || getAnalyticsMapper(platform, op) !== null;

  caps.canPublishOrganic = has('publish_post');
  caps.canUploadMedia = has('upload_media') || has('publish_post');
  caps.canReadPostInsights = canAnalytics('post_insights');
  caps.canReadAdInsights = canAnalytics('ad_insights');
  caps.canPublishAds = has('create_ad');

  if (!caps.canPublishOrganic) {
    caps.missingPermissions.push(`${platform}.publish_post action slug`);
  }
  if (!caps.canReadPostInsights) {
    caps.missingPermissions.push(`${platform}.post_insights (no analytics tool for this platform)`);
  }
  if (platform === 'meta_ads' && !caps.canPublishAds) {
    caps.missingPermissions.push('meta_ads.create_ad action slug');
  }

  for (const w of PLATFORM_WARNINGS[platform] ?? []) caps.warnings.push(w);

  if (caps.missingPermissions.length > 0) {
    caps.warnings.push(
      'Some operations are not yet configured. Set the corresponding COMPOSIO_<PLATFORM>_<OP>_ACTION env vars (see docs/integrations/composio.md) once verified for your toolkit version.',
    );
  }

  return caps;
}
