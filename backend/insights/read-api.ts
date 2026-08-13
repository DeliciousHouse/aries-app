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
import {
  INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS,
  insightsMicroCacheKey,
  microCacheControlHeader,
  readInsightsMicroCache,
  writeInsightsMicroCache,
} from './micro-cache';
import { resolveTenantInsightsTimeZone } from './tenant-timezone';
import { tenantZonePeriodStartDateKey } from '@/lib/format-timestamp';
import { LATEST_POST_METRICS_LATERAL } from './latest-post-metrics-sql';
import { accountEngagementSql } from './account-engagement-sql';
import {
  LATEST_FOLLOWERS_PER_PLATFORM_SUBQUERY,
  CURRENT_FOLLOWERS_SUM_SQL,
} from './current-followers-sql';

// AA-246 (F3): re-exported so tests/insights-summary-current-followers.
// requires-infra.test.ts and any other existing importer of
// CURRENT_FOLLOWERS_SUM_SQL from this module keep working unchanged. The
// constant itself now lives in current-followers-sql.ts (zero runtime
// imports), which is the module Trends' trends-snapshot-builder.ts imports
// from — importing it from here would transitively pull in `next/server` +
// `@/lib/db` (which constructs a `pg.Pool` at module scope) for a builder
// that otherwise has no runtime imports at all.
export { CURRENT_FOLLOWERS_SUM_SQL };

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseIntParam(value: string | null, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// ── Summary ───────────────────────────────────────────────────────────────────

/**
 * GET /api/insights/summary *
 * FRESHNESS (S7-3/AA-121): 60s micro-cache. These are whole-period aggregates
 * over daily account rows that the sync worker refreshes on a 30-minute cadence,
 * so the underlying data cannot change faster than the cache expires. A minute
 * of lag here is strictly finer-grained than the data itself.
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

  // S7-3/AA-121: cache check precedes pool.connect() — a hit costs no client.
  const cacheKey = insightsMicroCacheKey('summary', tenantId, { platform, days });
  const cached = readInsightsMicroCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  }

  const client = await pool.connect();

  try {
    // S2-3: summary aggregates the bare-DATE account-metrics table, so the window
    // is a tenant-tz calendar date ($2::date) in the tenant's business timezone.
    const tz      = await resolveTenantInsightsTimeZone(client, tenantId);
    const fromKey = tenantZonePeriodStartDateKey(days, tz);
    const res = await client.query<{
      total_reach:              string;
      current_followers:        string;
      followers_gained:         string;
      total_likes:              string;
      total_comments:           string;
      total_shares:             string;
      total_watch_time_minutes: string;
      total_engagement:         string;
    }>(
      `SELECT
         -- AA-230: prefer real reach over views (YouTube populates reach as
         -- unique viewers; Instagram/Facebook populate reach as organic reach).
         -- Matches every other LATEST_POST_METRICS_LATERAL consumer
         -- (top-snapshot-builder.ts, narrative/snapshot-builder.ts) — this was
         -- the one reader still reading views, which disagreed with /insights.
         COALESCE(SUM(COALESCE(reach, views, 0)), 0) AS total_reach,
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
         COALESCE(SUM(${accountEngagementSql()}), 0) AS total_engagement
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromKey, platform],
    );

    const row = res.rows[0];
    const body = {
      period: { days, from: fromKey },
      platform,
      totalReach:            Number(row.total_reach),
      currentFollowers:      Number(row.current_followers),
      followersGained:       Number(row.followers_gained),
      totalLikes:            Number(row.total_likes),
      totalComments:         Number(row.total_comments),
      totalShares:           Number(row.total_shares),
      totalWatchTimeMinutes: Number(row.total_watch_time_minutes),
      totalEngagement:       Number(row.total_engagement),
    };
    writeInsightsMicroCache(cacheKey, body, INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS);
    return NextResponse.json(body, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  } finally {
    client.release();
  }
}

// ── Posts ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/insights/posts *
 * FRESHNESS (S7-3/AA-121): 60s micro-cache, keyed on platform+limit+offset so
 * paging never serves another page's body. Per-post metrics are lifetime
 * snapshots written once per sync; a newly published post appears at most 60s
 * late, which is well inside the sync interval that would surface it anyway.
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

  // S7-3/AA-121: cache check precedes pool.connect() — a hit costs no client.
  const cacheKey = insightsMicroCacheKey('posts', tenantId, { platform, limit, offset });
  const cached = readInsightsMicroCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  }

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
      total_reach:         string;
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
         -- AA-230: reach-preferred, matching every other LATEST_POST_METRICS_LATERAL
         -- consumer (top-snapshot-builder.ts, narrative/snapshot-builder.ts).
         COALESCE(m.reach, m.views, 0)    AS total_reach,
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
        totalReach:         Number(row.total_reach),
        totalLikes:         Number(row.total_likes),
        totalComments:      Number(row.total_comments),
        totalShares:        Number(row.total_shares),
        avgViewPercentage:  row.avg_view_percentage != null ? Number(row.avg_view_percentage) : null,
      },
    }));

    const body = { posts, limit, offset, count: posts.length };
    writeInsightsMicroCache(cacheKey, body, INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS);
    return NextResponse.json(body, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  } finally {
    client.release();
  }
}

// ── Account metrics (time series) ─────────────────────────────────────────────

/**
 * GET /api/insights/account-metrics *
 * FRESHNESS (S7-3/AA-121): 60s micro-cache. A daily time series, keyed on
 * platform+days; the newest point is a whole day's bucket, so sub-minute
 * freshness is meaningless at this grain.
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

  // S7-3/AA-121: cache check precedes pool.connect() — a hit costs no client.
  const cacheKey = insightsMicroCacheKey('account-metrics', tenantId, { platform, days });
  const cached = readInsightsMicroCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  }

  const client = await pool.connect();

  try {
    // S2-3: bare-DATE account-metrics time-series windowed by a tenant-tz calendar
    // date ($2::date) in the tenant's business timezone.
    const tz      = await resolveTenantInsightsTimeZone(client, tenantId);
    const fromKey = tenantZonePeriodStartDateKey(days, tz);
    const res = await client.query<{
      date:                 string;
      platform:             string;
      reach:                string;
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
         -- AA-230: reach-preferred, matching every other
         -- LATEST_POST_METRICS_LATERAL consumer.
         COALESCE(SUM(COALESCE(reach, views, 0)), 0) AS reach,
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
      reach:              Number(row.reach),
      watchTimeMinutes:   Number(row.watch_time_minutes),
      followers:          Number(row.followers),
      followersDelta:     Number(row.followers_delta),
      likes:              Number(row.likes),
      commentsCount:      Number(row.comments_count),
      shares:             Number(row.shares),
    }));

    const body = {
      period: { days, from: fromKey },
      platform,
      series,
    };
    writeInsightsMicroCache(cacheKey, body, INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS);
    return NextResponse.json(body, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  } finally {
    client.release();
  }
}

// ── Comments ──────────────────────────────────────────────────────────────────

/**
 * GET /api/insights/comments *
 * FRESHNESS (S7-3/AA-121): 60s micro-cache — the shortest window allowed,
 * because this list carries reply state. It is INVALIDATED for the tenant when a
 * reply succeeds (see the native-reply handler), so an operator never watches
 * their own reply fail to appear; only newly ARRIVED comments can lag, by up to
 * 60s.
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

  // S7-3/AA-121: cache check precedes pool.connect() — a hit costs no client.
  const cacheKey = insightsMicroCacheKey('comments', tenantId, { platform, postId, limit });
  const cached = readInsightsMicroCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  }

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

    const body = { comments, limit, count: comments.length };
    writeInsightsMicroCache(cacheKey, body, INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS);
    return NextResponse.json(body, {
      headers: { 'Cache-Control': microCacheControlHeader(INSIGHTS_MICRO_CACHE_DEFAULT_TTL_MS) },
    });
  } finally {
    client.release();
  }
}
