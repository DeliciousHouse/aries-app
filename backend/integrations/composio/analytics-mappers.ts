/**
 * Per-platform analytics mappers for Composio.
 *
 * Each (platform, operation) pair declares:
 *   - `slug`: the verified Composio tool slug (env-overridable via
 *     COMPOSIO_<PLATFORM>_<OP>_ACTION).
 *   - `buildArgs`: turns Aries' normalized request + the connected account's
 *     external id into the tool's REAL required arguments (these differ a lot:
 *     IG wants `ig_media_id` + a `metric[]`, FB wants `page_id`, YouTube wants
 *     `id: [videoId]`, LinkedIn wants an `urn:li:organization:` URN, Meta Ads
 *     wants `object_id` + `level`).
 *   - `parse`: turns the tool's REAL response shape into partial
 *     NormalizedMetrics. Graph insights come back as
 *     `data.data[] = {name, values:[{value}]}`; YouTube as
 *     `data.items[].statistics` (string numbers); LinkedIn as
 *     `data.elements[].totalShareStatistics`; Meta Ads as `data.data[]` rows.
 *
 * A metric the response does not contain stays absent here, so the provider
 * leaves it null — never a fabricated zero. Verified against the live Composio
 * tool schemas (input + output) on 2026-06-03.
 */

import type { IntegrationPlatform, NormalizedMetrics } from '../providers/types';
import type { ComposioOperation } from './composio-config';

export interface MapperContext {
  /** The connected account's platform-side id (page id / ig user id / channel id / org id / ad account id). */
  externalAccountId: string | null;
  /** The platform post id for post-level insights (= platform_post_id from publish). */
  externalPostId?: string | null;
  /** The ad/campaign id for ad-level insights. */
  externalAdId?: string | null;
  externalCampaignId?: string | null;
  since?: string;
  until?: string;
}

export interface PlatformAnalyticsMapper {
  slug: string;
  buildArgs(ctx: MapperContext): Record<string, unknown>;
  parse(raw: unknown): Partial<NormalizedMetrics>;
}

// --- response helpers -------------------------------------------------------

/**
 * Coerce a loose value (number or numeric string) to a finite number, else null.
 * Exported so the insights Facebook adapter parses the same Graph payloads with
 * the identical numeric semantics (no fabricated zeros).
 */
export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Unwrap one layer of Composio's `{ data: <toolPayload> }` if present. */
function payload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  if (obj.data && typeof obj.data === 'object') return obj.data as Record<string, unknown>;
  return obj;
}

/**
 * Parse a Graph insights array (`data: [{ name, values: [{ value }] }]` or
 * `[{ name, total_value: { value } }]`) into name -> number. Handles the
 * extra `.data` wrap FB/IG tools add (payload().data is the array).
 */
export function graphInsights(raw: unknown): Record<string, number> {
  const r = (raw ?? {}) as Record<string, unknown>;
  // The InsightMetric array lands at raw.data (Composio tool payload) or
  // raw.data.data (extra wrap on some tools).
  let arr: unknown[] = [];
  if (Array.isArray(r.data)) arr = r.data;
  else if (r.data && typeof r.data === 'object' && Array.isArray((r.data as Record<string, unknown>).data)) {
    arr = (r.data as Record<string, unknown>).data as unknown[];
  }
  const out: Record<string, number> = {};
  for (const entry of arr as Array<Record<string, unknown>>) {
    const name = typeof entry?.name === 'string' ? entry.name : null;
    if (!name) continue;
    let value: number | null = null;
    if (Array.isArray(entry.values) && entry.values.length > 0) {
      // last non-null value in the series
      for (let i = entry.values.length - 1; i >= 0; i -= 1) {
        const v = num((entry.values[i] as Record<string, unknown>)?.value);
        if (v !== null) { value = v; break; }
      }
    } else if (entry.total_value && typeof entry.total_value === 'object') {
      value = num((entry.total_value as Record<string, unknown>).value);
    }
    if (value !== null) out[name] = value;
  }
  return out;
}

const FB_PAGE_METRICS = 'page_media_view,page_video_views,page_post_engagements,page_follows';
const IG_MEDIA_METRICS = ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'];
const IG_USER_METRICS = ['reach', 'views', 'likes', 'comments', 'shares', 'saves', 'total_interactions', 'accounts_engaged'];

function linkedinOrgUrn(externalAccountId: string | null): string {
  const id = (externalAccountId ?? '').trim();
  if (!id) return '';
  return id.startsWith('urn:li:organization:') ? id : `urn:li:organization:${id}`;
}

function parseLinkedinShareStats(raw: unknown): Partial<NormalizedMetrics> {
  const p = payload(raw);
  const elements = Array.isArray(p.elements) ? (p.elements as Array<Record<string, unknown>>) : [];
  const stats = (elements[0]?.totalShareStatistics ?? {}) as Record<string, unknown>;
  return {
    impressions: num(stats.impressionCount),
    reach: num(stats.uniqueImpressionsCount),
    clicks: num(stats.clickCount),
    likes: num(stats.likeCount),
    comments: num(stats.commentCount),
    shares: num(stats.shareCount),
  };
}

/**
 * Parse a LINKEDIN_LIST_REACTIONS collection (`{ elements, paging:{ total } }`)
 * into the PERSONAL reaction count, mapped HONESTLY onto `likes`. Precedence:
 * authoritative `paging.total` first; else the length of `elements`; else absent
 * (`likes` stays null — never a fabricated zero). This is the only verified
 * engagement signal for a personal LinkedIn account (org share stats need
 * organization-admin scope — see parseLinkedinShareStats / linkedin:account_insights).
 */
function parseLinkedinReactions(raw: unknown): Partial<NormalizedMetrics> {
  const p = payload(raw);
  // The collection may sit at the unwrapped layer or one `.data` deeper.
  const collection = ('elements' in p || 'paging' in p) ? p : payload(p);
  const paging = collection.paging && typeof collection.paging === 'object'
    ? (collection.paging as Record<string, unknown>)
    : null;
  const total = paging ? num(paging.total) : null;
  if (total !== null) return { likes: total };
  const elements = collection.elements;
  if (Array.isArray(elements)) return { likes: elements.length };
  return {};
}

function parseYoutubeStatistics(raw: unknown): Partial<NormalizedMetrics> {
  const p = payload(raw);
  const items = Array.isArray(p.items) ? (p.items as Array<Record<string, unknown>>) : [];
  const stats = (items[0]?.statistics ?? {}) as Record<string, unknown>;
  return {
    views: num(stats.viewCount),
    likes: num(stats.likeCount),
    comments: num(stats.commentCount),
  };
}

function parseMetaAdsRow(raw: unknown): Partial<NormalizedMetrics> {
  const r = (raw ?? {}) as Record<string, unknown>;
  // Meta Ads insights rows land at raw.data or raw.data.data.
  let inner: unknown[] = [];
  if (Array.isArray(r.data)) inner = r.data;
  else if (r.data && typeof r.data === 'object' && Array.isArray((r.data as Record<string, unknown>).data)) {
    inner = (r.data as Record<string, unknown>).data as unknown[];
  }
  const row = (inner.length > 0 ? inner[0] : {}) as Record<string, unknown>;
  const sumActions = (v: unknown): number | null => {
    if (!Array.isArray(v)) return null;
    let total = 0; let seen = false;
    for (const a of v as Array<Record<string, unknown>>) {
      const n = num(a?.value);
      if (n !== null) { total += n; seen = true; }
    }
    return seen ? total : null;
  };
  const spend = num(row.spend);
  const conversions = sumActions(row.actions);
  const revenue = sumActions(row.action_values);
  return {
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    spend,
    cpm: num(row.cpm),
    cpc: num(row.cpc),
    ctr: num(row.ctr),
    conversions,
    revenue,
    costPerResult: spend !== null && conversions ? Number((spend / conversions).toFixed(4)) : null,
    roas: revenue !== null && spend ? Number((revenue / spend).toFixed(4)) : null,
  };
}

/** Registry: `${platform}:${op}` -> mapper. Absent key = unsupported (unavailable). */
const MAPPERS: Partial<Record<string, PlatformAnalyticsMapper>> = {
  // Facebook
  'facebook:post_insights': {
    slug: 'FACEBOOK_GET_POST_INSIGHTS',
    buildArgs: (ctx) => ({ post_id: ctx.externalPostId, metrics: 'post_media_view' }),
    parse: (raw) => {
      const g = graphInsights(raw);
      return { views: g.post_media_view ?? null, impressions: g.post_media_view ?? null };
    },
  },
  'facebook:account_insights': {
    slug: 'FACEBOOK_GET_PAGE_INSIGHTS',
    buildArgs: (ctx) => ({ page_id: ctx.externalAccountId, metrics: FB_PAGE_METRICS, period: 'day', ...(ctx.since ? { since: ctx.since } : {}), ...(ctx.until ? { until: ctx.until } : {}) }),
    parse: (raw) => {
      const g = graphInsights(raw);
      return { impressions: g.page_media_view ?? null, views: g.page_video_views ?? null };
    },
  },
  // Instagram
  'instagram:post_insights': {
    slug: 'INSTAGRAM_GET_IG_MEDIA_INSIGHTS',
    buildArgs: (ctx) => ({ ig_media_id: ctx.externalPostId, metric: IG_MEDIA_METRICS }),
    parse: (raw) => {
      const g = graphInsights(raw);
      return {
        views: g.views ?? null, reach: g.reach ?? null, likes: g.likes ?? null,
        comments: g.comments ?? null, saves: g.saved ?? null, shares: g.shares ?? null,
      };
    },
  },
  'instagram:account_insights': {
    slug: 'INSTAGRAM_GET_USER_INSIGHTS',
    buildArgs: (ctx) => ({ metric: IG_USER_METRICS, period: 'day', ...(ctx.externalAccountId ? { ig_user_id: ctx.externalAccountId } : {}) }),
    parse: (raw) => {
      const g = graphInsights(raw);
      return {
        views: g.views ?? null, reach: g.reach ?? null, likes: g.likes ?? null,
        comments: g.comments ?? null, saves: g.saves ?? null, shares: g.shares ?? null,
      };
    },
  },
  // TikTok (account-level only; no per-post insights tool)
  'tiktok:account_insights': {
    slug: 'TIKTOK_GET_USER_STATS',
    buildArgs: () => ({ fields: ['follower_count', 'likes_count', 'video_count'] }),
    parse: (raw) => {
      const p = payload(raw);
      const stats = ((p.user ?? p) as Record<string, unknown>);
      return { likes: num(stats.likes_count) };
    },
  },
  // YouTube
  'youtube:post_insights': {
    slug: 'YOUTUBE_GET_VIDEO_DETAILS_BATCH',
    buildArgs: (ctx) => ({ id: [ctx.externalPostId], parts: ['statistics'] }),
    parse: parseYoutubeStatistics,
  },
  'youtube:account_insights': {
    slug: 'YOUTUBE_GET_CHANNEL_STATISTICS',
    buildArgs: (ctx) => (ctx.externalAccountId ? { id: ctx.externalAccountId, part: 'statistics' } : { mine: true, part: 'statistics' }),
    parse: (raw) => {
      const p = payload(raw);
      const items = Array.isArray(p.items) ? (p.items as Array<Record<string, unknown>>) : [];
      const stats = (items[0]?.statistics ?? {}) as Record<string, unknown>;
      return { views: num(stats.viewCount) };
    },
  },
  // X (Twitter) — single-tweet lookup; public_metrics carries the engagement.
  // impression_count is paid-tier-gated, so impressions is null when absent
  // (never a fabricated zero). Nesting: raw.data (Composio) .data (X v2 single
  // lookup) .public_metrics.
  'x:post_insights': {
    slug: 'TWITTER_POST_LOOKUP_BY_POST_ID',
    buildArgs: (ctx) => ({ id: ctx.externalPostId, tweet_fields: 'public_metrics' }),
    parse: (raw) => {
      const p = payload(raw);
      const tweet = (p.data && typeof p.data === 'object' && !Array.isArray(p.data)
        ? (p.data as Record<string, unknown>)
        : p);
      const pm = (tweet.public_metrics && typeof tweet.public_metrics === 'object'
        ? (tweet.public_metrics as Record<string, unknown>)
        : {});
      return {
        impressions: num(pm.impression_count),
        likes: num(pm.like_count),
        comments: num(pm.reply_count),
        shares: num(pm.retweet_count),
      };
    },
  },
  // LinkedIn (personal per-post reactions → likes). entity is the post URN
  // (share/ugcPost/activity) passed VERBATIM — never guess/prepend a urn:li:
  // prefix. Personal reactions expose no impressions/reach/comment/share, so
  // those stay null (never a fabricated zero); the org-level metrics need
  // organization-admin scope (linkedin:account_insights, below).
  'linkedin:post_insights': {
    slug: 'LINKEDIN_LIST_REACTIONS',
    buildArgs: (ctx) => ({ entity: ctx.externalPostId, count: 100 }),
    parse: parseLinkedinReactions,
  },
  // LinkedIn (organization-level share stats)
  'linkedin:account_insights': {
    slug: 'LINKEDIN_GET_SHARE_STATS',
    buildArgs: (ctx) => ({ organizational_entity: linkedinOrgUrn(ctx.externalAccountId) }),
    parse: parseLinkedinShareStats,
  },
  // Meta Ads
  'meta_ads:ad_insights': {
    slug: 'METAADS_GET_INSIGHTS',
    buildArgs: (ctx) => ({
      object_id: ctx.externalAdId ?? ctx.externalCampaignId ?? ctx.externalAccountId,
      level: ctx.externalAdId ? 'ad' : ctx.externalCampaignId ? 'campaign' : 'account',
      fields: ['impressions', 'clicks', 'spend', 'reach', 'cpc', 'cpm', 'ctr', 'actions', 'action_values'],
      ...(ctx.since && ctx.until ? { time_range: { since: ctx.since, until: ctx.until } } : {}),
    }),
    parse: parseMetaAdsRow,
  },
};

export function getAnalyticsMapper(
  platform: IntegrationPlatform,
  op: ComposioOperation,
): PlatformAnalyticsMapper | null {
  return MAPPERS[`${platform}:${op}`] ?? null;
}
