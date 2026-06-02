/**
 * backend/insights/platforms/capabilities.ts
 *
 * Per-platform capability matrix.
 *
 * The sync dispatcher uses this to skip API calls for features a platform
 * doesn't support, and to decide which adapter methods to invoke.
 *
 * When a new platform capability is added (e.g. 'story_metrics'), add it here
 * first — TypeScript will flag any adapter that forgets to declare support.
 */

import type { Platform } from './registry';

export type PlatformCapability =
  | 'account_daily_metrics'   // channel-level daily views, followers, watch time
  | 'post_list'               // list of published posts / videos
  | 'post_daily_metrics'      // per-post daily breakdowns
  | 'comments'                // per-post comment fetch
  | 'audience_demographics'   // age/gender/country breakdown
  | 'watch_time'              // cumulative watch-time minutes
  | 'avg_view_duration'       // average view duration per video
  | 'reach_impressions'       // reach + impressions (Meta concept, not YouTube)
  | 'saves';                  // saves / bookmarks (Instagram, Facebook)

export const PLATFORM_CAPABILITIES: Record<Platform, ReadonlySet<PlatformCapability>> = {
  youtube: new Set<PlatformCapability>([
    'account_daily_metrics',
    'post_list',
    'post_daily_metrics',
    'comments',
    'audience_demographics',
    'watch_time',
    'avg_view_duration',
  ]),
  instagram: new Set<PlatformCapability>([
    'account_daily_metrics',
    'post_list',
    'post_daily_metrics',
    'comments',
    'audience_demographics',
    'reach_impressions',
    'saves',
  ]),
  facebook: new Set<PlatformCapability>([
    'account_daily_metrics',
    'post_list',
    'post_daily_metrics',
    'comments',
    'reach_impressions',
  ]),
};

/** Returns true if the given platform supports a specific capability. */
export function platformSupports(platform: Platform, capability: PlatformCapability): boolean {
  return PLATFORM_CAPABILITIES[platform].has(capability);
}

/** Returns the full capability set for a platform. Useful for UI feature flags. */
export function getPlatformCapabilities(platform: Platform): ReadonlySet<PlatformCapability> {
  return PLATFORM_CAPABILITIES[platform];
}
