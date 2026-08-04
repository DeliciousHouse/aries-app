/**
 * backend/insights/adapters/_adapter.types.ts
 *
 * The InsightsAdapter contract.
 *
 * Every platform adapter (YouTube, Instagram, Facebook, …) must implement
 * this interface. The sync dispatcher calls only these methods — never the
 * platform API directly. This keeps the sync logic platform-agnostic and
 * lets us swap or mock adapters in tests without any special harness.
 *
 * Raw return types use camelCase field names; the sync dispatcher maps
 * them to snake_case before writing to the DB.
 */

import type { Platform } from '../platforms/registry';

// ── Primitive helpers ─────────────────────────────────────────────────────────

/** A date string in YYYY-MM-DD format (no time component). */
export type DateString = string;

/** Inclusive date range for metric queries. */
export interface DateRange {
  from: DateString;
  to: DateString;
}

// ── Raw return shapes ─────────────────────────────────────────────────────────

/** One day of account-level metrics returned by the adapter. */
export interface RawAccountMetricsDay {
  date: DateString;
  views: number;
  watchTimeMinutes: number;
  followers: number;
  followersDelta: number;
  likes: number;
  commentsCount: number;
  shares: number;
  /**
   * Authoritative aggregate account engagement for the day, when the platform
   * reports a single engagement figure rather than a like/comment/share
   * breakdown (Facebook's `page_post_engagements`). Persisted to the dedicated
   * `engagement` column; read-api prefers it for the headline engagement and
   * falls back to likes+comments+shares when null. Omit/null when not exposed.
   */
  engagement?: number | null;
  /**
   * S4-2 (gap C3). Unique accounts reached that day. Same NULL-vs-0 contract as
   * `RawPostMetricsDay.reach` — null means "not exposed / not read", never zero.
   *
   * Deliberately NOT added here: `saves` and `profileVisits`, even though
   * `insights_account_metrics_daily` has columns for both. Neither has a source.
   * Instagram's account insights expose neither (its `profile_views` metric is
   * DEPRECATED by Meta), and Facebook Pages have no saves concept. Adding
   * contract fields nothing can populate would just move the silent-zero
   * problem up a layer. The product_sales goal now reads saves from the POST
   * table, where Instagram genuinely reports them.
   */
  reach?: number | null;
  /** Original platform API response fields — stored in raw_source JSONB. */
  rawSource: Record<string, unknown>;
}

/** A single post / video as returned by the adapter's listing call. */
export interface RawPost {
  externalPostId: string;
  publishedAt: Date;
  /** 'video' | 'short' | 'reel' | 'image' | 'carousel' — platform-normalised. */
  mediaType: 'video' | 'short' | 'reel' | 'image' | 'carousel';
  title: string | null;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
}

/** One day of post-level metrics returned by the adapter. */
export interface RawPostMetricsDay {
  date: DateString;
  views: number;
  watchTimeMinutes: number;
  avgViewDurationSec: number;
  avgViewPercentage: number;
  likes: number;
  commentsCount: number;
  shares: number;
  /**
   * S4-2 (gap C3). Unique accounts reached, and saves/bookmarks.
   *
   * NULL-vs-0 IS LOAD-BEARING and is the whole point of these being optional:
   *   null/omitted — this platform does not expose the metric, or this fetch
   *                  could not read it. NEVER coerce to 0.
   *   0            — the platform reported a real zero.
   *
   * A fabricated 0 is indistinguishable from a measured 0 downstream, and the
   * goal section renders that number to the operator as fact (the product_sales
   * "0 saves" trap). Availability today: Instagram reports both per post;
   * Facebook Pages have no saves concept at all and its reach metric is a
   * separate follow-up (deliberately split out of this ticket), so FB leaves
   * both null.
   */
  reach?: number | null;
  saves?: number | null;
  rawSource: Record<string, unknown>;
}

/** A single comment returned by the adapter. */
export interface RawComment {
  externalCommentId: string;
  receivedAt: Date;
  authorHandle: string | null;
  bodyText: string;
}

// ── Adapter construction context ──────────────────────────────────────────────

/**
 * Per-tenant connection context handed to an adapter at construction time.
 *
 * Most adapters (e.g. YouTube, which uses its own OAuth tokens) ignore this.
 * Composio-backed adapters (Facebook) need the per-tenant Composio
 * `connectedAccountId` to authenticate every tool call; `pageId` is the
 * platform-side account id (mirrors `insights_accounts.external_account_id`).
 * `tenantId` is supplied for adapters that source their post list from Aries'
 * own DB (e.g. X, which has no Composio "list my tweets" action); FB/YouTube
 * ignore it.
 */
export interface InsightsAdapterContext {
  connectedAccountId?: string | null;
  pageId?: string | null;
  tenantId?: number | null;
}

// ── The adapter interface ─────────────────────────────────────────────────────

export interface InsightsAdapter {
  /** Identifies which platform this adapter is for. */
  readonly platform: Platform;

  /**
   * Fetch account-level daily metrics for a date range.
   *
   * @param externalAccountId — the platform-native account/channel ID
   *   (stored in insights_accounts.external_account_id).
   * @param range — inclusive date range.
   * @returns One entry per day that has data; days with no data may be omitted.
   */
  fetchAccountMetrics(
    externalAccountId: string,
    range: DateRange,
  ): Promise<RawAccountMetricsDay[]>;

  /**
   * Fetch the list of posts/videos published by this account.
   *
   * @param externalAccountId — the platform-native account/channel ID.
   * @param publishedAfter — if provided, only return posts published after
   *   this date (used for incremental syncs; omit for a full backfill).
   */
  fetchPostList(
    externalAccountId: string,
    publishedAfter?: Date,
  ): Promise<RawPost[]>;

  /**
   * Fetch daily metrics for a single post.
   *
   * @param externalPostId — the platform-native post/video ID.
   * @param range — optional date range; adapters may default to the last 30 days.
   */
  fetchPostMetrics(
    externalPostId: string,
    range?: DateRange,
  ): Promise<RawPostMetricsDay[]>;

  /**
   * Fetch recent comments on a post.
   *
   * @param externalPostId — the platform-native post/video ID.
   * @param limit — cap the number of comments returned (default adapter-specific).
   */
  fetchComments(
    externalPostId: string,
    limit?: number,
  ): Promise<RawComment[]>;
}
