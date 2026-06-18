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
  | 'post_view_count'         // per-post view/impression count (youtube, instagram, facebook only)
  | 'comments'                // per-post comment fetch
  | 'audience_demographics'   // age/gender/country breakdown
  | 'watch_time'              // cumulative watch-time minutes
  | 'avg_view_duration'       // average view duration per video
  | 'reach_impressions'       // reach + impressions (Meta concept, not YouTube)
  | 'saves';                  // saves / bookmarks (Instagram, Facebook)

export const PLATFORM_CAPABILITIES: Record<Platform, ReadonlySet<PlatformCapability>> = {
  // YouTube via Composio: per-video statistics (views/likes/comments) +
  // top-level comment threads. Deliberately OMITS 'account_daily_metrics'
  // (no verified per-day channel series), 'watch_time'/'avg_view_duration'
  // (not delivered by GET_VIDEO_DETAILS_BATCH), and 'audience_demographics'
  // (not fetched) — the adapter only delivers these three.
  youtube: new Set<PlatformCapability>([
    'post_list',
    'post_daily_metrics',
    'post_view_count',
    'comments',
  ]),
  instagram: new Set<PlatformCapability>([
    'account_daily_metrics',
    'post_list',
    'post_daily_metrics',
    'post_view_count',
    'comments',
    'audience_demographics',
    'reach_impressions',
    'saves',
  ]),
  facebook: new Set<PlatformCapability>([
    'account_daily_metrics',
    'post_list',
    'post_daily_metrics',
    'post_view_count',
    'comments',
    'reach_impressions',
  ]),
  // X (Twitter): per-post engagement (likes/replies/retweets) + replies-as-
  // comments. Deliberately OMITS 'account_daily_metrics' (no verified X
  // account-insights action) and 'reach_impressions' (impression_count is
  // paid-tier-gated — see the X adapter's documented impressions limitation).
  x: new Set<PlatformCapability>([
    'post_list',
    'post_daily_metrics',
    'comments',
  ]),
  // Reddit: per-post engagement (score/num_comments/upvote_ratio via
  // REDDIT_RETRIEVE_REDDIT_POST) + top-level post comments. Deliberately OMITS
  // 'account_daily_metrics' (no verified Reddit account-insights action) and
  // 'reach_impressions' — Reddit exposes NO impressions/reach metric at all
  // (the absent reach cap IS the documented Reddit analytics limitation).
  reddit: new Set<PlatformCapability>([
    'post_list',
    'post_daily_metrics',
    'comments',
  ]),
  // LinkedIn via Composio (#647 analytics): per-post PERSONAL reaction counts
  // (LINKEDIN_LIST_REACTIONS → likes). Deliberately OMITS 'comments' (#648):
  // LinkedIn exposes NO Composio list-comments action, so the adapter ingests no
  // comments and the UI advertises no LinkedIn comment feature — a genuine
  // platform limitation, not a stub. Also OMITS 'account_daily_metrics'
  // (LINKEDIN_GET_SHARE_STATS is organization-admin only; #645 captured the
  // person URN, not an org URN — an org-stats follow-up) and 'reach_impressions'
  // (personal reactions expose no impressions/reach metric).
  linkedin: new Set<PlatformCapability>([
    'post_list',
    'post_daily_metrics',
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
