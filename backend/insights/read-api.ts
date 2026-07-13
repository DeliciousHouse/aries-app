/**
 * backend/insights/read-api.ts
 *
 * Read-path handler functions for the insights API.
 * Each function is called by a thin route.ts in app/api/insights/.
 *
 * All queries are tenant-scoped — tenant_id is always the first filter.
 * Platform is an optional filter; passing null returns data across all platforms.
 *
 * pg returns BIGINT and NUMERIC columns as strings — every aggregated number
 * is coerced with Number() before returning to the caller.
 */

import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import { resolveTenantInsightsTimeZone } from './tenant-timezone';
import { tenantZonePeriodStartDateKey } from '@/lib/format-timestamp';
import { LATEST_POST_METRICS_LATERAL } from './latest-post-metrics-sql';

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseIntParam(value: string | null, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// S1-8 / AA-87: currentFollowers = SUM of each platform's LATEST follower count.
// NOT MAX across platforms (which shows only the largest single platform — a
// multi-platform tenant with FB 10k + IG 6k wrongly saw 10k) and NOT SUM across
// dates (which multiplies by the number of daily snapshots). DISTINCT ON
// (platform) ORDER BY platform, date DESC takes the most recent non-null
// follower row per platform; the outer SUM adds those per-platform latest
// values. Uncorrelated scalar subquery (uses only $1/$2/$3), so it composes
// with the other SUM aggregates in the summary query. Exported standalone so
// the requires-infra test proves the exact expression against the real schema.
const LATEST_FOLLOWERS_PER_PLATFORM_SUBQUERY = `
      SELECT COALESCE(SUM(latest.followers), 0)
      FROM (
        SELECT DISTINCT ON (platform) followers
        FROM insights_account_metrics_daily
        WHERE tenant_id = $1
          AND date >= $2
          AND ($3::text IS NULL OR platform = $3)
          AND followers IS NOT NULL
        ORDER BY platform, date DESC
      ) latest`;

export const CURRENT_FOLLOWERS_SUM_SQL =
  `SELECT (${LATEST_FOLLOWERS_PER_PLATFORM_SUBQUERY}) AS current_followers`;

// ── Summary ───────────────────────────────────────────────────────────────────

/**
 * GET /api/insights/summary
 *
 * Query params:
 *   platform  — optional platform filter (youtube | instagram | facebook | …)
 *   days      — lookback window in days (default 30, max 90)
 */
export async function handleGetInsightsSummary(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const { searchParams } = new URL(req.url);
  const platform = searchParams.get('platform') || null;
  const days     = clamp(parseIntParam(searchParams.get('days'), 30), 1, 90);

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const client = await pool.connect();

  try {
    // S2-3: summary aggregates the bare-DATE account-metrics table, so the window
    // is a tenant-tz calendar date ($2::date) in the tenant's business timezone.
    const tz      = await resolveTenantInsightsTimeZone(client, tenantId);
    const fromKey = tenantZonePeriodStartDateKey(days, tz);
    const res = await client.query<{
      total_views:              string;
      current_followers:        string;
      followers_gained:         string;
      total_likes:              string;
      total_comments:           string;
      total_shares:             string;
      total_watch_time_minutes: string;
      total_engagement:         string;
    }>(
      `SELECT
         COALESCE(SUM(views), 0)              AS total_views,
         (${LATEST_FOLLOWERS_PER_PLATFORM_SUBQUERY}) AS current_followers,
         COALESCE(SUM(followers_delta), 0)    AS followers_gained,
         COALESCE(SUM(likes), 0)              AS total_likes,
         COALESCE(SUM(comments_count), 0)     AS total_comments,
         COALESCE(SUM(shares), 0)             AS total_shares,
         COALESCE(SUM(watch_time_minutes), 0) AS total_watch_time_minutes,
         -- Prefer the authoritative aggregate engagement column (Facebook's
         -- page_post_engagements) when present; fall back to the like/comment/
         -- share breakdown for platforms that report one. Never a fake 0 when a
         -- real aggregate exists.
         COALESCE(SUM(
           COALESCE(engagement,
                    COALESCE(likes, 0) + COALESCE(comments_count, 0) + COALESCE(shares, 0))
         ), 0)                                AS total_engagement
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromKey, platform],
    );

    const row = res.rows[0];
    return NextResponse.json({
      period: { days, from: fromKey },
      platform,
      totalViews:            Number(row.total_views),
      currentFollowers:      Number(row.current_followers),
      followersGained:       Number(row.followers_gained),
      totalLikes:            Number(row.total_likes),
      totalComments:         Number(row.total_comments),
      totalShares:           Number(row.total_shares),
      totalWatchTimeMinutes: Number(row.total_watch_time_minutes),
      totalEngagement:       Number(row.total_engagement),
    });
  } finally {
    client.release();
  }
}

// ── Posts ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/insights/posts
 *
 * Returns posts with their aggregated lifetime metrics.
 *
 * Query params:
 *   platform  — optional platform filter
 *   limit     — page size (default 20, max 100)
 *   offset    — pagination offset (default 0)
 */
export async function handleGetInsightsPosts(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const { searchParams } = new URL(req.url);
  const platform = searchParams.get('platform') || null;
  const limit    = clamp(parseIntParam(searchParams.get('limit'),  20), 1, 100);
  const offset   = Math.max(parseIntParam(searchParams.get('offset'), 0), 0);

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const client = await pool.connect();

  try {
    const res = await client.query<{
      id:                  number;
      platform:            string;
      external_post_id:    string;
      title:               string | null;
      media_type:          string;
      published_at:        Date;
      permalink:           string | null;
      duration_seconds:    number | null;
      platform_data:       Record<string, unknown>;
      total_views:         string;
      total_likes:         string;
      total_comments:      string;
      total_shares:        string;
      avg_view_percentage: string | null;
    }>(
      `SELECT
         p.id,
         p.platform,
         p.external_post_id,
         p.title,
         p.media_type,
         p.published_at,
         p.permalink,
         p.duration_seconds,
         p.platform_data,
         -- S2-1: per-post metrics are lifetime-cumulative snapshots (one row per
         -- day, each an all-time running total), so the latest row IS the true
         -- lifetime total. SUMming across dates inflated it ~N×. Take the newest
         -- snapshot per post via LATERAL (same idiom as posting-time-advisor).
         COALESCE(m.views, 0)             AS total_views,
         COALESCE(m.likes, 0)             AS total_likes,
         COALESCE(m.comments_count, 0)    AS total_comments,
         COALESCE(m.shares, 0)            AS total_shares,
         NULLIF(m.avg_view_percentage, 0) AS avg_view_percentage
       FROM insights_posts p
       ${LATEST_POST_METRICS_LATERAL}
       WHERE p.tenant_id = $1
         AND ($2::text IS NULL OR p.platform = $2)
       ORDER BY p.published_at DESC
       LIMIT $3 OFFSET $4`,
      [tenantId, platform, limit, offset],
    );

    const posts = res.rows.map((row) => ({
      id:              row.id,
      platform:        row.platform,
      externalPostId:  row.external_post_id,
      title:           row.title,
      mediaType:       row.media_type,
      publishedAt:     row.published_at,
      permalink:       row.permalink,
      durationSeconds: row.duration_seconds,
      thumbnailUrl:    (row.platform_data as Record<string, unknown>)?.thumbnailUrl ?? null,
      metrics: {
        totalViews:         Number(row.total_views),
        totalLikes:         Number(row.total_likes),
        totalComments:      Number(row.total_comments),
        totalShares:        Number(row.total_shares),
        avgViewPercentage:  row.avg_view_percentage != null ? Number(row.avg_view_percentage) : null,
      },
    }));

    return NextResponse.json({ posts, limit, offset, count: posts.length });
  } finally {
    client.release();
  }
}

// ── Account metrics (time series) ─────────────────────────────────────────────

/**
 * GET /api/insights/account-metrics
 *
 * Returns daily time-series data — one row per (date, platform).
 * Used to render charts on the analytics dashboard.
 *
 * Query params:
 *   platform  — optional platform filter
 *   days      — lookback window (default 30, max 90)
 */
export async function handleGetInsightsAccountMetrics(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const { searchParams } = new URL(req.url);
  const platform = searchParams.get('platform') || null;
  const days     = clamp(parseIntParam(searchParams.get('days'), 30), 1, 90);

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const client = await pool.connect();

  try {
    // S2-3: bare-DATE account-metrics time-series windowed by a tenant-tz calendar
    // date ($2::date) in the tenant's business timezone.
    const tz      = await resolveTenantInsightsTimeZone(client, tenantId);
    const fromKey = tenantZonePeriodStartDateKey(days, tz);
    const res = await client.query<{
      date:                 string;
      platform:             string;
      views:                string;
      watch_time_minutes:   string;
      followers:            string;
      followers_delta:      string;
      likes:                string;
      comments_count:       string;
      shares:               string;
    }>(
      `SELECT
         date::text,
         platform,
         COALESCE(SUM(views), 0)              AS views,
         COALESCE(SUM(watch_time_minutes), 0) AS watch_time_minutes,
         COALESCE(MAX(followers), 0)          AS followers,
         COALESCE(SUM(followers_delta), 0)    AS followers_delta,
         COALESCE(SUM(likes), 0)              AS likes,
         COALESCE(SUM(comments_count), 0)     AS comments_count,
         COALESCE(SUM(shares), 0)             AS shares
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND ($3::text IS NULL OR platform = $3)
       GROUP BY date, platform
       ORDER BY date ASC`,
      [tenantId, fromKey, platform],
    );

    const series = res.rows.map((row) => ({
      date:               row.date,
      platform:           row.platform,
      views:              Number(row.views),
      watchTimeMinutes:   Number(row.watch_time_minutes),
      followers:          Number(row.followers),
      followersDelta:     Number(row.followers_delta),
      likes:              Number(row.likes),
      commentsCount:      Number(row.comments_count),
      shares:             Number(row.shares),
    }));

    return NextResponse.json({
      period: { days, from: fromKey },
      platform,
      series,
    });
  } finally {
    client.release();
  }
}

// ── Comments ──────────────────────────────────────────────────────────────────

/**
 * GET /api/insights/comments
 *
 * Returns recent comments with the title of the post they belong to.
 *
 * Query params:
 *   platform  — optional platform filter
 *   postId    — optional: restrict to comments on one post
 *   limit     — max comments to return (default 50, max 200)
 */
export async function handleGetInsightsComments(
  req: Request,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) return tenantResult.response;

  const { searchParams } = new URL(req.url);
  const platform = searchParams.get('platform') || null;
  const postId   = parseIntParam(searchParams.get('postId'), 0) || null;
  const limit    = clamp(parseIntParam(searchParams.get('limit'), 50), 1, 200);

  const tenantId = Number(tenantResult.tenantContext.tenantId);
  const client = await pool.connect();

  try {
    const res = await client.query<{
      id:               number;
      post_id:          number;
      platform:         string;
      author_handle:    string | null;
      body_text:        string;
      received_at:      Date;
      is_replied:       boolean | null;
      replied_at:       Date | null;
      post_title:       string | null;
      post_permalink:   string | null;
    }>(
      `SELECT
         c.id,
         c.post_id,
         c.platform,
         c.author_handle,
         c.body_text,
         c.received_at,
         c.is_replied,
         c.replied_at,
         p.title      AS post_title,
         p.permalink  AS post_permalink
       FROM insights_comments c
       LEFT JOIN insights_posts p ON p.id = c.post_id AND p.tenant_id = c.tenant_id
       WHERE c.tenant_id = $1
         AND ($2::text IS NULL OR c.platform = $2)
         AND ($3::int  IS NULL OR c.post_id  = $3)
       ORDER BY c.received_at DESC
       LIMIT $4`,
      [tenantId, platform, postId, limit],
    );

    const comments = res.rows.map((row) => ({
      id:            row.id,
      postId:        row.post_id,
      platform:      row.platform,
      authorHandle:  row.author_handle,
      bodyText:      row.body_text,
      receivedAt:    row.received_at,
      isReplied:     Boolean(row.is_replied),
      repliedAt:     row.replied_at,
      postTitle:     row.post_title,
      postPermalink: row.post_permalink,
    }));

    return NextResponse.json({ comments, limit, count: comments.length });
  } finally {
    client.release();
  }
}
