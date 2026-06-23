/**
 * backend/insights/adapters/instagram/index.ts
 *
 * Instagram insights adapter — backed by Composio (#692 analytics, #693 comments).
 *
 * Every platform call goes through the Composio gateway (`executeTool`) so the
 * adapter depends on a small, mockable surface; tests inject a fake gateway and
 * never touch the network. The verified Composio action slugs are the defaults,
 * each overridable via `COMPOSIO_INSTAGRAM_<OP>_ACTION` (resolved through
 * `ComposioConfig.actionSlugFor`).
 *
 * Method → action:
 *   fetchPostList       → INSTAGRAM_GET_IG_USER_MEDIA      (per-post engagement)
 *   fetchPostMetrics    → INSTAGRAM_GET_IG_MEDIA_INSIGHTS  (views + engagement)
 *   fetchAccountMetrics → INSTAGRAM_GET_USER_INSIGHTS + INSTAGRAM_GET_USER_INFO
 *   fetchComments       → INSTAGRAM_GET_IG_MEDIA_COMMENTS
 *
 * IG vs FB deltas:
 *   - like_count/comments_count are on the MEDIA OBJECT (not .summary(true)).
 *   - 'impressions' is DEPRECATED → use 'views' throughout.
 *   - 'profile_views'/'impressions' are DEPRECATED for account insights.
 *   - Per-post insights require Business/Creator + ≥1000 followers.
 *     When restricted, fetchPostMetrics FAIL-SOFTs: falls back to the
 *     engagementCache populated by fetchPostList, emits [] only when there is
 *     no signal at all (never fabricates a 0-view row).
 *   - media_type: IMAGE→image, VIDEO→video, CAROUSEL_ALBUM→carousel, REELS→reel.
 *
 * Dormant-safe: activates only when COMPOSIO_ENABLED + ANALYTICS_PROVIDER=composio
 * (the same gate as Facebook). IG has no connected active row in prod today, so
 * the adapter is live but idle until IG connect ships.
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
  list_posts:       'INSTAGRAM_GET_IG_USER_MEDIA',
  post_insights:    'INSTAGRAM_GET_IG_MEDIA_INSIGHTS',
  account_insights: 'INSTAGRAM_GET_USER_INSIGHTS',
  account_info:     'INSTAGRAM_GET_USER_INFO',
  list_comments:    'INSTAGRAM_GET_IG_MEDIA_COMMENTS',
};

/**
 * Media metric list for per-post insights. 'impressions' is DEPRECATED — use
 * 'views'. 'saved' has no DB column but is carried in rawSource.
 */
const IG_POST_METRICS = ['views', 'reach', 'saved', 'likes', 'comments', 'shares', 'total_interactions'];

/**
 * Account-level daily metrics. 'profile_views' and 'impressions' are DEPRECATED.
 * 'follower_count' returns an absolute snapshot per day (like FB's page_follows).
 */
const IG_ACCOUNT_METRICS = ['reach', 'follower_count', 'views'];

const IG_MEDIA_FIELDS =
  'id,caption,permalink,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count';

const IG_COMMENT_FIELDS = 'id,text,username,timestamp,like_count,parent_id';

// ── Response unwrapping helpers (shared shape with FB adapter) ─────────────────

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

/** Resolve a Graph single-object response (e.g. user info). */
function unwrapToObject(raw: unknown): Record<string, unknown> {
  const peeled = unwrap(raw);
  if (peeled && typeof peeled === 'object' && !Array.isArray(peeled)) {
    return peeled as Record<string, unknown>;
  }
  return {};
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

function igMediaType(row: Record<string, unknown>): RawPost['mediaType'] {
  const mt = typeof row.media_type === 'string' ? row.media_type.toUpperCase() : '';
  if (mt === 'VIDEO') return 'video';
  if (mt === 'CAROUSEL_ALBUM') return 'carousel';
  if (mt === 'REELS') return 'reel';
  return 'image'; // IMAGE and unknown default to image
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class InstagramInsightsAdapter implements InsightsAdapter {
  readonly platform = 'instagram' as const;

  /**
   * Per-post engagement captured in fetchPostList from the media object's
   * like_count / comments_count fields (no .summary(true) needed for IG).
   * Read by fetchPostMetrics as fallback when post-level insights are restricted.
   */
  private readonly engagementCache = new Map<
    string,
    { likes: number | null; comments: number | null }
  >();

  constructor(
    private readonly gateway: ComposioGateway,
    private readonly config: ComposioConfig,
    private readonly ctx: InsightsAdapterContext = {},
  ) {}

  private slugFor(op: ComposioOperation): string {
    const override = this.config.actionSlugFor('instagram', op);
    const slug = override ?? DEFAULT_SLUGS[op];
    if (!slug) throw new Error(`No Composio Instagram action slug configured for "${op}".`);
    return slug;
  }

  private connectedAccountId(): string {
    const id = this.ctx.connectedAccountId?.trim();
    if (!id) {
      throw new Error('InstagramInsightsAdapter: no Composio connectedAccountId in context.');
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
      throw new Error(result.error ?? `Composio Instagram ${op} call reported unsuccessful.`);
    }
    return result.data ?? null;
  }

  /**
   * Single page of up to 100 media items. IG returns like_count and
   * comments_count directly on the media object — no .summary(true) needed.
   * Results are cached in engagementCache for fetchPostMetrics fallback.
   */
  async fetchPostList(externalAccountId: string, _publishedAfter?: Date): Promise<RawPost[]> {
    const data = await this.exec('list_posts', {
      ig_user_id: externalAccountId,
      fields: IG_MEDIA_FIELDS,
      limit: 100,
    });
    const rows = unwrapToArray(data);

    const posts: RawPost[] = [];
    for (const row of rows) {
      const externalPostId = typeof row.id === 'string' ? row.id : null;
      if (!externalPostId) continue;

      // Cache per-media engagement for fetchPostMetrics fallback. IG exposes
      // like_count and comments_count directly on the media object.
      this.engagementCache.set(externalPostId, {
        likes: num(row.like_count),
        comments: num(row.comments_count),
      });

      posts.push({
        externalPostId,
        publishedAt: toDate(row.timestamp),
        mediaType: igMediaType(row),
        title: null,
        caption: typeof row.caption === 'string' ? row.caption : null,
        permalink: typeof row.permalink === 'string' ? row.permalink : null,
        thumbnailUrl:
          typeof row.thumbnail_url === 'string' ? row.thumbnail_url
          : typeof row.media_url === 'string' ? row.media_url
          : null,
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
      ig_user_id: externalAccountId,
      metric: IG_ACCOUNT_METRICS,
      period: 'day',
      since: range.from,
      until: range.to,
    });

    // Follower snapshot is best-effort: a failure here must not drop the daily
    // reach/views series we already fetched.
    let followersCount: number | null = null;
    try {
      const details = unwrapToObject(
        await this.exec('account_info', {
          ig_user_id: externalAccountId,
          fields: 'followers_count',
        }),
      );
      followersCount = num(details.followers_count);
    } catch {
      followersCount = null;
    }

    // Pivot the per-metric time series into one record per day.
    //   reach         → daily reach (unique accounts reached)
    //   follower_count → absolute follower snapshot for that day (like FB page_follows)
    //   views         → account/content views (replaces deprecated impressions)
    // null = the metric had no value that day (never coerced to a fabricated 0).
    type Day = {
      reach: number | null;
      followerCount: number | null;
      views: number | null;
    };
    const byDay = new Map<string, Day>();
    const ensure = (date: string): Day => {
      let d = byDay.get(date);
      if (!d) {
        d = { reach: null, followerCount: null, views: null };
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
          case 'reach':          day.reach = value; break;
          case 'follower_count': day.followerCount = value; break;
          case 'views':          day.views = value; break;
          default: break;
        }
      }
    }

    // Ensure the most recent day exists so the authoritative USER_INFO
    // follower count below has a row to land on.
    const latestDate = range.to;
    if (followersCount !== null) ensure(latestDate);

    const out: RawAccountMetricsDay[] = [];
    for (const [date, d] of byDay) {
      // Absolute follower count: on the latest day prefer the authoritative
      // USER_INFO followers_count; otherwise use the daily follower_count metric.
      // NEVER derived from a followersDelta.
      const absoluteFollowers =
        (date === latestDate && followersCount !== null ? followersCount : null) ?? d.followerCount;

      // IG metrics don't include a daily follower-gain/loss breakdown from this
      // endpoint, so followersDelta is always 0 (no fabricated subtraction).
      const followersDelta = 0;

      out.push({
        date,
        views: d.views ?? 0,
        watchTimeMinutes: 0,
        followers: absoluteFollowers ?? 0,
        followersDelta,
        // IG account insights at this level don't expose like/comment/share
        // breakdown — those come from post-level insights.
        likes: 0,
        commentsCount: 0,
        shares: 0,
        // No composite engagement aggregate at the account level from these metrics.
        rawSource: {
          source: 'INSTAGRAM_GET_USER_INSIGHTS',
          reach: d.reach,
          follower_count: d.followerCount,
          views: d.views,
          followers_count: followersCount,
        },
      });
    }
    return out;
  }

  /**
   * Fetch per-post metrics via INSTAGRAM_GET_IG_MEDIA_INSIGHTS.
   *
   * Per-post insights require a Business/Creator account with ≥1000 followers.
   * When the call fails or returns no signal (restricted account), we FAIL-SOFT:
   * fall back to the like_count/comments_count cached from fetchPostList.
   * We never fabricate a 0-view row — if there is truly no signal at all,
   * we return [] (mirrors Facebook adapter nil-emission guard).
   *
   * 'impressions' is DEPRECATED; we request 'views' instead.
   * 'saved' has no dedicated DB column but is carried in rawSource.
   */
  async fetchPostMetrics(externalPostId: string, _range?: DateRange): Promise<RawPostMetricsDay[]> {
    const engagement = this.engagementCache.get(externalPostId) ?? null;

    let views: number | null = null;
    let reach: number | null = null;
    let insightLikes: number | null = null;
    let insightComments: number | null = null;
    let insightShares: number | null = null;
    let saved: number | null = null;
    let totalInteractions: number | null = null;

    try {
      const data = await this.exec('post_insights', {
        ig_media_id: externalPostId,
        metric: IG_POST_METRICS,
      });

      for (const metric of unwrapToArray(data)) {
        const name = typeof metric.name === 'string' ? metric.name : null;
        if (!name) continue;
        const values = Array.isArray(metric.values) ? (metric.values as Array<Record<string, unknown>>) : [];
        // Take the last non-null value in the series (lifetime metrics typically
        // have one entry; this handles both per-day and lifetime shapes).
        let value: number | null = null;
        for (let i = values.length - 1; i >= 0; i -= 1) {
          const v = num(values[i]?.value);
          if (v !== null) { value = v; break; }
        }
        switch (name) {
          case 'views':               views = value; break;
          case 'reach':               reach = value; break;
          case 'likes':               insightLikes = value; break;
          case 'comments':            insightComments = value; break;
          case 'shares':              insightShares = value; break;
          case 'saved':               saved = value; break;
          case 'total_interactions':  totalInteractions = value; break;
          default: break;
        }
      }
    } catch {
      // Post insights unavailable (restricted account, <1000 followers, API error).
      // Fall back to engagementCache populated by fetchPostList. Never wedges the
      // sync run for the whole post list — this post is handled gracefully.
    }

    // Only emit a row when there is a real signal — never fabricate a zero row
    // for a post we have no data on (mirrors FB adapter nil-emission guard).
    if (views === null && !engagement) return [];

    const date = new Date().toISOString().split('T')[0];
    return [
      {
        date,
        views: views ?? 0,
        watchTimeMinutes: 0,
        avgViewDurationSec: 0,
        avgViewPercentage: 0,
        likes: insightLikes ?? engagement?.likes ?? 0,
        commentsCount: insightComments ?? engagement?.comments ?? 0,
        shares: insightShares ?? 0,
        rawSource: {
          source: 'INSTAGRAM_GET_IG_MEDIA_INSIGHTS',
          views,
          reach,
          likes: insightLikes,
          comments: insightComments,
          shares: insightShares,
          saved,
          total_interactions: totalInteractions,
          engagement_from_post_list: engagement,
        },
      },
    ];
  }

  async fetchComments(externalPostId: string, limit = 100): Promise<RawComment[]> {
    const data = await this.exec('list_comments', {
      ig_media_id: externalPostId,
      fields: IG_COMMENT_FIELDS,
      limit: Math.min(Math.max(limit, 1), 100),
    });

    const out: RawComment[] = [];
    for (const row of unwrapToArray(data)) {
      const externalCommentId = typeof row.id === 'string' ? row.id : null;
      if (!externalCommentId) continue;
      out.push({
        externalCommentId,
        receivedAt: toDate(row.timestamp),
        authorHandle: typeof row.username === 'string' ? row.username : null,
        bodyText: typeof row.text === 'string' ? row.text : '',
      });
    }
    return out;
  }
}

/**
 * Build a context-bound Instagram adapter wired to the live Composio gateway.
 * Throws (via createComposioGateway) when Composio is enabled but no API key is
 * configured — the dispatcher catches that and marks the sync run failed.
 */
export function createInstagramInsightsAdapter(
  ctx: InsightsAdapterContext = {},
  env: NodeJS.ProcessEnv = process.env,
): InstagramInsightsAdapter {
  const config = resolveComposioConfig(env);
  const gateway = createComposioGateway(config);
  return new InstagramInsightsAdapter(gateway, config!, ctx);
}
