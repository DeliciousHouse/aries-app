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
 */
export interface InsightsAdapterContext {
  connectedAccountId?: string | null;
  pageId?: string | null;
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
