/**
 * backend/insights/adapters/facebook/index.ts
 *
 * Facebook insights adapter — backed by Composio (#596 analytics, #597 comments).
 *
 * Every platform call goes through the Composio gateway (`executeTool`) so the
 * adapter depends on a small, mockable surface; tests inject a fake gateway and
 * never touch the network. The verified Composio action slugs are the defaults,
 * each overridable via `COMPOSIO_FACEBOOK_<OP>_ACTION` (resolved through
 * `ComposioConfig.actionSlugFor`).
 *
 * Method → action:
 *   fetchPostList     → FACEBOOK_GET_PAGE_POSTS     (source of per-post engagement)
 *   fetchAccountMetrics → FACEBOOK_GET_PAGE_INSIGHTS + FACEBOOK_GET_PAGE_DETAILS
 *   fetchPostMetrics  → FACEBOOK_GET_POST_INSIGHTS  (views) + cached list engagement
 *   fetchComments     → FACEBOOK_GET_COMMENTS
 *
 * Deprecation note: Facebook removed post-level engagement metrics on
 * 2025-11-15, so FACEBOOK_GET_POST_INSIGHTS now mostly returns `post_media_view`
 * (views) only. Per-post likes/comments/shares therefore come from the
 * `.summary(true)` counts captured during fetchPostList and cached on the
 * adapter instance (the dispatcher reuses one adapter for the whole sync, calling
 * fetchPostList before fetchPostMetrics).
 */

import type {
  InsightsAdapter,
  InsightsAdapterContext,
  DateRange,
  RawAccountMetricsDay,
  RawPost,
  RawPostMetricsDay,
  RawComment,
} from '../_adapter.types';
import type { ComposioConfig, ComposioOperation } from '@/backend/integrations/composio/composio-config';
import type { ComposioGateway } from '@/backend/integrations/composio/composio-client';
import { resolveComposioConfig } from '@/backend/integrations/composio/composio-config';
import { createComposioGateway } from '@/backend/integrations/composio/composio-client';
import { num } from '@/backend/integrations/composio/analytics-mappers';

// ── Verified default action slugs (env-overridable) ────────────────────────────

const DEFAULT_SLUGS: Partial<Record<ComposioOperation, string>> = {
  list_posts: 'FACEBOOK_GET_PAGE_POSTS',
  post_insights: 'FACEBOOK_GET_POST_INSIGHTS',
  account_insights: 'FACEBOOK_GET_PAGE_INSIGHTS',
  account_info: 'FACEBOOK_GET_PAGE_DETAILS',
  list_comments: 'FACEBOOK_GET_COMMENTS',
};

/** Page-level metrics to request (≤90d window). Engagement/follower oriented. */
const FB_PAGE_METRICS =
  'page_media_view,page_video_views,page_post_engagements,page_follows,page_daily_follows_unique,page_daily_unfollows_unique';

/** Fields that carry per-post engagement summary counts + display metadata. */
const FB_POST_FIELDS =
  'id,message,created_time,permalink_url,full_picture,status_type,attachments,reactions.summary(true),comments.summary(true),shares';

const FB_COMMENT_FIELDS = 'id,message,created_time,from';

// ── Response unwrapping helpers ────────────────────────────────────────────────

/**
 * Descend through Composio's `{ data: <toolPayload> }` envelope wrappers. The
 * exact nesting (one vs two `.data` layers) varies by tool/SDK version, so we
 * peel object-with-`data` wrappers until we hit an array or a leaf object.
 */
function unwrap(raw: unknown): unknown {
  let cur = raw;
  for (let i = 0; i < 3; i += 1) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) break;
    const obj = cur as Record<string, unknown>;
    if (!('data' in obj)) break;
    cur = obj.data;
  }
  return cur;
}

/** Resolve a Graph list response into its row array, however it is nested. */
function unwrapToArray(raw: unknown): Array<Record<string, unknown>> {
  const peeled = unwrap(raw);
  if (Array.isArray(peeled)) return peeled as Array<Record<string, unknown>>;
  if (peeled && typeof peeled === 'object' && Array.isArray((peeled as Record<string, unknown>).data)) {
    return (peeled as Record<string, unknown>).data as Array<Record<string, unknown>>;
  }
  return [];
}

/** Resolve a Graph single-object response (e.g. page details). */
function unwrapToObject(raw: unknown): Record<string, unknown> {
  const peeled = unwrap(raw);
  if (peeled && typeof peeled === 'object' && !Array.isArray(peeled)) {
    return peeled as Record<string, unknown>;
  }
  return {};
}

function summaryCount(node: unknown): number | null {
  if (!node || typeof node !== 'object') return null;
  const summary = (node as Record<string, unknown>).summary;
  if (summary && typeof summary === 'object') {
    return num((summary as Record<string, unknown>).total_count);
  }
  return null;
}

function sharesCount(node: unknown): number | null {
  if (!node || typeof node !== 'object') return null;
  return num((node as Record<string, unknown>).count);
}

function toDate(value: unknown): Date {
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

function dateStr(value: unknown): string {
  return toDate(value).toISOString().split('T')[0];
}

function fbMediaType(post: Record<string, unknown>): RawPost['mediaType'] {
  const status = typeof post.status_type === 'string' ? post.status_type.toLowerCase() : '';
  const attachments = unwrapToArray(post.attachments);
  const first = attachments[0] ?? {};
  const mediaType = typeof first.media_type === 'string' ? first.media_type.toLowerCase() : '';
  const type = typeof first.type === 'string' ? first.type.toLowerCase() : '';
  if (mediaType === 'video' || type.includes('video') || status.includes('video')) return 'video';
  if (type === 'album' || mediaType === 'album') return 'carousel';
  const sub = unwrapToArray((first as Record<string, unknown>).subattachments);
  if (sub.length > 1) return 'carousel';
  return 'image';
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class FacebookInsightsAdapter implements InsightsAdapter {
  readonly platform = 'facebook' as const;

  /** Per-post engagement summary captured in fetchPostList, read in fetchPostMetrics. */
  private readonly engagementCache = new Map<
    string,
    { likes: number | null; comments: number | null; shares: number | null }
  >();

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly ctx: InsightsAdapterContext = {},
  ) {}

  private slugFor(op: ComposioOperation): string {
    const override = this.config.actionSlugFor('facebook', op);
    const slug = override ?? DEFAULT_SLUGS[op];
    if (!slug) throw new Error(`No Composio Facebook action slug configured for "${op}".`);
    return slug;
  }

  private connectedAccountId(): string {
    const id = this.ctx.connectedAccountId?.trim();
    if (!id) {
      throw new Error('FacebookInsightsAdapter: no Composio connectedAccountId in context.');
    }
    return id;
  }

  /** Execute a tool; throw on a hard (successful=false) failure so the sync run
   * is marked failed while already-committed rows are preserved. */
  private async exec(op: ComposioOperation, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.gateway.executeTool(this.slugFor(op), {
      connectedAccountId: this.connectedAccountId(),
      arguments: args,
    });
    if (!result.successful) {
      throw new Error(result.error ?? `Composio Facebook ${op} call reported unsuccessful.`);
    }
    return result.data ?? null;
  }

  async fetchPostList(externalAccountId: string, publishedAfter?: Date): Promise<RawPost[]> {
    const args: Record<string, unknown> = {
      page_id: externalAccountId,
      limit: 100,
      fields: FB_POST_FIELDS,
    };
    if (publishedAfter) args.since = String(Math.floor(publishedAfter.getTime() / 1000));

    const data = await this.exec('list_posts', args);
    const rows = unwrapToArray(data);

    const posts: RawPost[] = [];
    for (const row of rows) {
      const externalPostId = typeof row.id === 'string' ? row.id : null;
      if (!externalPostId) continue;

      this.engagementCache.set(externalPostId, {
        likes: summaryCount(row.reactions),
        comments: summaryCount(row.comments),
        shares: sharesCount(row.shares),
      });

      posts.push({
        externalPostId,
        publishedAt: toDate(row.created_time),
        mediaType: fbMediaType(row),
        title: null,
        caption: typeof row.message === 'string' ? row.message : null,
        permalink: typeof row.permalink_url === 'string' ? row.permalink_url : null,
        thumbnailUrl: typeof row.full_picture === 'string' ? row.full_picture : null,
        durationSeconds: null,
      });
    }
    return posts;
  }

  async fetchAccountMetrics(
    externalAccountId: string,
    range: DateRange,
  ): Promise<RawAccountMetricsDay[]> {
    const insightsData = await this.exec('account_insights', {
      page_id: externalAccountId,
      metrics: FB_PAGE_METRICS,
      period: 'day',
      since: range.from,
      until: range.to,
    });

    // Followers snapshot is best-effort: a failure here must not drop the daily
    // engagement series we already fetched.
    let followersCount: number | null = null;
    try {
      const details = unwrapToObject(
        await this.exec('account_info', {
          page_id: externalAccountId,
          fields: 'followers_count,fan_count',
        }),
      );
      followersCount = num(details.followers_count) ?? num(details.fan_count);
    } catch {
      followersCount = null;
    }

    // Pivot the per-metric time series into one record per day. Each field
    // tracks its OWN source metric so cumulative and daily signals are never
    // conflated (see the follower math below). null = the metric had no value
    // that day (never coerced to a fabricated 0).
    type Day = {
      mediaView: number | null;      // page_media_view (content views)
      videoViews: number | null;     // page_video_views
      engagements: number | null;    // page_post_engagements (DAILY engagement count)
      pageFollows: number | null;    // page_follows (ABSOLUTE cumulative follower total)
      dailyFollows: number | null;   // page_daily_follows_unique (DAILY new follows)
      dailyUnfollows: number | null; // page_daily_unfollows_unique (DAILY unfollows)
    };
    const byDay = new Map<string, Day>();
    const ensure = (date: string): Day => {
      let d = byDay.get(date);
      if (!d) {
        d = { mediaView: null, videoViews: null, engagements: null, pageFollows: null, dailyFollows: null, dailyUnfollows: null };
        byDay.set(date, d);
      }
      return d;
    };

    for (const metric of unwrapToArray(insightsData)) {
      const name = typeof metric.name === 'string' ? metric.name : null;
      if (!name) continue;
      const values = Array.isArray(metric.values) ? (metric.values as Array<Record<string, unknown>>) : [];
      for (const v of values) {
        const value = num(v.value);
        if (value === null) continue;
        const day = ensure(dateStr(v.end_time));
        switch (name) {
          case 'page_media_view': day.mediaView = value; break;
          case 'page_video_views': day.videoViews = value; break;
          case 'page_post_engagements': day.engagements = value; break;
          case 'page_follows': day.pageFollows = value; break;
          case 'page_daily_follows_unique': day.dailyFollows = value; break;
          case 'page_daily_unfollows_unique': day.dailyUnfollows = value; break;
          default: break;
        }
      }
    }

    // Ensure the most recent day exists so the authoritative PAGE_DETAILS
    // follower count below has a row to land on.
    const latestDate = range.to;
    if (followersCount !== null) ensure(latestDate);

    const out: RawAccountMetricsDay[] = [];
    for (const [date, d] of byDay) {
      // Absolute follower count: the cumulative page_follows for that day; on the
      // latest day prefer the authoritative PAGE_DETAILS followers_count. NEVER
      // derived from a daily follows/unfollows value.
      const absoluteFollowers =
        (date === latestDate && followersCount !== null ? followersCount : null) ?? d.pageFollows;
      // Daily net change: new follows − unfollows, BOTH daily metrics. Computed
      // only when at least one daily signal exists, so a day with no signal is 0
      // (no change) rather than a bogus cumulative-minus-daily subtraction.
      const followersDelta =
        d.dailyFollows !== null || d.dailyUnfollows !== null
          ? (d.dailyFollows ?? 0) - (d.dailyUnfollows ?? 0)
          : 0;

      out.push({
        date,
        views: d.mediaView ?? 0,
        watchTimeMinutes: 0,
        followers: absoluteFollowers ?? 0,
        followersDelta,
        // FB exposes no like/comment/share breakdown at the page level — only the
        // aggregate page_post_engagements, surfaced via the dedicated `engagement`
        // field (read-api uses it for the headline engagement, not these zeros).
        likes: 0,
        commentsCount: 0,
        shares: 0,
        engagement: d.engagements,
        rawSource: {
          source: 'FACEBOOK_GET_PAGE_INSIGHTS',
          page_media_view: d.mediaView,
          page_video_views: d.videoViews,
          page_post_engagements: d.engagements,
          page_follows: d.pageFollows,
          page_daily_follows_unique: d.dailyFollows,
          page_daily_unfollows_unique: d.dailyUnfollows,
          followers_count: followersCount,
        },
      });
    }
    return out;
  }

  async fetchPostMetrics(externalPostId: string, _range?: DateRange): Promise<RawPostMetricsDay[]> {
    const data = await this.exec('post_insights', { post_id: externalPostId, metrics: 'post_media_view' });

    let views: number | null = null;
    for (const metric of unwrapToArray(data)) {
      if (metric.name !== 'post_media_view') continue;
      const values = Array.isArray(metric.values) ? (metric.values as Array<Record<string, unknown>>) : [];
      for (let i = values.length - 1; i >= 0; i -= 1) {
        const v = num(values[i]?.value);
        if (v !== null) { views = v; break; }
      }
    }

    const engagement = this.engagementCache.get(externalPostId) ?? null;

    // Only emit a row when there is a real signal — never fabricate a zero row
    // for a post we have no data on.
    if (views === null && !engagement) return [];

    const date = new Date().toISOString().split('T')[0];
    return [
      {
        date,
        views: views ?? 0,
        watchTimeMinutes: 0,
        avgViewDurationSec: 0,
        avgViewPercentage: 0,
        likes: engagement?.likes ?? 0,
        commentsCount: engagement?.comments ?? 0,
        shares: engagement?.shares ?? 0,
        rawSource: {
          source: 'FACEBOOK_GET_POST_INSIGHTS',
          post_media_view: views,
          engagement_from_post_list: engagement,
        },
      },
    ];
  }

  async fetchComments(externalPostId: string, limit = 100): Promise<RawComment[]> {
    const data = await this.exec('list_comments', {
      object_id: externalPostId,
      limit: Math.min(Math.max(limit, 1), 100),
      order: 'reverse_chronological',
      fields: FB_COMMENT_FIELDS,
      filter: 'stream',
    });

    const out: RawComment[] = [];
    for (const row of unwrapToArray(data)) {
      const externalCommentId = typeof row.id === 'string' ? row.id : null;
      if (!externalCommentId) continue;
      const from = (row.from ?? null) as Record<string, unknown> | null;
      out.push({
        externalCommentId,
        receivedAt: toDate(row.created_time),
        authorHandle: from && typeof from.name === 'string' ? from.name : null,
        bodyText: typeof row.message === 'string' ? row.message : '',
      });
    }
    return out;
  }
}

/**
 * Build a context-bound Facebook adapter wired to the live Composio gateway.
 * Throws (via createComposioGateway) when Composio is enabled but no API key is
 * configured — the dispatcher catches that and marks the sync run failed.
 */
export function createFacebookInsightsAdapter(
  ctx: InsightsAdapterContext = {},
  env: NodeJS.ProcessEnv = process.env,
): FacebookInsightsAdapter {
  const config = resolveComposioConfig(env);
  const gateway = createComposioGateway(config);
  return new FacebookInsightsAdapter(gateway, config!, ctx);
}
