/**
 * backend/insights/narrative/snapshot-builder.ts
 *
 * Queries the DB for a (tenant, period, platform) combination and returns
 * the NarrativeSnapshot used by the template builder to assemble Hero Band text.
 *
 * "platform" can be a specific platform string ('youtube', 'instagram', etc.)
 * or 'all' to aggregate across every connected platform for this tenant.
 *
 * Reach logic: COALESCE(reach, views) — YouTube populates reach as unique viewers,
 * Instagram/Facebook populate reach as organic reach, views is the fallback.
 */

import pool from '@/lib/db';
import { LATEST_POST_METRICS_LATERAL } from '../latest-post-metrics-sql';
import { resolveTenantInsightsTimeZone } from '../tenant-timezone';
import { tenantZonePeriodStart, tenantZonePeriodStartDateKey } from '@/lib/format-timestamp';
import { estimateHoursSaved } from '../hours-saved';

export type NarrativePeriod = 'week' | '30day' | '90day';

export interface TopPost {
  title: string;
  platform: string;
  metric: number;
  metricLabel: string;
}

export interface NarrativeSnapshot {
  platform: string;
  period: NarrativePeriod;
  posts: number;
  postsLabel: string;          // 'post' | 'video' | platform-specific
  reach: number;
  reachPrev: number;
  reachDelta: number;          // % change vs previous equivalent period
  reachLabel: string;          // 'people' | 'unique viewers' | 'impressions'
  engagementRate: number;      // (likes+comments+shares)/reach*100
  engagementRatePrev: number;  // same metric for previous period (used for scoreDelta)
  comments: number;            // total comments received in period
  unreplied: number;
  hoursSaved: number;          // estimated hours Aries saved this period
  topPost: TopPost | null;
  watchTimeMinutes: number | null;  // populated for youtube and 'all'
  hasData: boolean;
}

// ── Platform label helpers ─────────────────────────────────────────────────────
// Extend these when adding new platforms (X, Reddit, TikTok, etc.)

function getReachLabel(platform: string): string {
  if (platform === 'youtube') return 'unique viewers';
  // x/twitter: 'impressions'  ← add when X adapter lands
  return 'people';
}

function getPostsLabel(platform: string): string {
  if (platform === 'youtube') return 'video';
  return 'post';
}

function includeWatchTime(platform: string): boolean {
  return platform === 'youtube' || platform === 'all';
}

// ── Period helpers ─────────────────────────────────────────────────────────────

function periodDays(period: NarrativePeriod): number {
  if (period === 'week')  return 7;
  if (period === '30day') return 30;
  return 90;
}

function pctDelta(current: number, prev: number): number {
  if (prev === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - prev) / prev) * 1000) / 10; // 1 decimal
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildNarrativeSnapshot(
  tenantId: number,
  period: NarrativePeriod,
  platform: string,
): Promise<NarrativeSnapshot> {
  const days          = periodDays(period);
  const platformFilter = platform === 'all' ? null : platform;

  const client = await pool.connect();
  try {
    // S2-3: windows in the tenant's business timezone. Account-daily (bare DATE)
    // totals use the tenant-tz calendar date ($n::date); post/comment windows on
    // published_at / received_at (timestamptz) use the tenant-tz-midnight instant.
    const tz       = await resolveTenantInsightsTimeZone(client, tenantId);
    const fromDate = tenantZonePeriodStart(days, tz);
    const prevFrom = tenantZonePeriodStart(days * 2, tz);
    const fromKey  = tenantZonePeriodStartDateKey(days, tz);
    const prevKey  = tenantZonePeriodStartDateKey(days * 2, tz);

    // Current period account-level totals
    const metricsRes = await client.query<{
      reach:              string;
      likes:              string;
      comments_count:     string;
      shares:             string;
      watch_time_minutes: string;
    }>(
      `SELECT
         COALESCE(SUM(COALESCE(reach, views, 0)), 0) AS reach,
         COALESCE(SUM(likes), 0)                     AS likes,
         COALESCE(SUM(comments_count), 0)            AS comments_count,
         COALESCE(SUM(shares), 0)                    AS shares,
         COALESCE(SUM(watch_time_minutes), 0)        AS watch_time_minutes
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromKey, platformFilter],
    );

    // Previous period totals (for delta + scoreDelta)
    const prevRes = await client.query<{
      reach:          string;
      likes:          string;
      comments_count: string;
      shares:         string;
    }>(
      `SELECT
         COALESCE(SUM(COALESCE(reach, views, 0)), 0) AS reach,
         COALESCE(SUM(likes), 0)                     AS likes,
         COALESCE(SUM(comments_count), 0)            AS comments_count,
         COALESCE(SUM(shares), 0)                    AS shares
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND date < $3::date
         AND ($4::text IS NULL OR platform = $4)`,
      [tenantId, prevKey, fromKey, platformFilter],
    );

    // Post count published in period
    const postCountRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM insights_posts
       WHERE tenant_id = $1
         AND published_at >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    );

    // Top post by reach/views in period
    const topPostRes = await client.query<{
      title:       string | null;
      platform:    string;
      total_reach: string;
    }>(
      `SELECT
         p.title,
         p.platform,
         -- S2-1: latest lifetime snapshot per post, NOT SUM across dated rows.
         COALESCE(m.reach, m.views, 0) AS total_reach
       FROM insights_posts p
       ${LATEST_POST_METRICS_LATERAL}
       WHERE p.tenant_id = $1
         AND p.published_at >= $2
         AND ($3::text IS NULL OR p.platform = $3)
       ORDER BY total_reach DESC
       LIMIT 1`,
      [tenantId, fromDate, platformFilter],
    );

    // Comments received in period: total + unreplied in one query
    const commentsRes = await client.query<{
      total:    string;
      unreplied: string;
    }>(
      `SELECT
         COUNT(*)                                    AS total,
         COUNT(*) FILTER (WHERE is_replied = false)  AS unreplied
       FROM insights_comments
       WHERE tenant_id = $1
         AND received_at >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    );

    // ── Assemble snapshot ────────────────────────────────────────────────────
    const m         = metricsRes.rows[0];
    const p         = prevRes.rows[0];
    const reach     = Number(m.reach);
    const reachPrev = Number(p.reach);
    const likes     = Number(m.likes);
    const commentsFromMetrics = Number(m.comments_count);
    const shares    = Number(m.shares);
    const watchTime = Number(m.watch_time_minutes);
    const posts     = Number(postCountRes.rows[0].count);

    const prevLikes    = Number(p.likes);
    const prevComments = Number(p.comments_count);
    const prevShares   = Number(p.shares);

    const commentsTotal = Number(commentsRes.rows[0].total);
    const unreplied     = Number(commentsRes.rows[0].unreplied);

    const engagementRate = reach > 0
      ? Math.round(((likes + commentsFromMetrics + shares) / reach) * 10000) / 100
      : 0;

    const engagementRatePrev = reachPrev > 0
      ? Math.round(((prevLikes + prevComments + prevShares) / reachPrev) * 10000) / 100
      : 0;

    // S3-1: hours saved is a synthetic ESTIMATE (rendered with "~"), reconciled to
    // the shared estimateHoursSaved so the Hero band and the Activity strip can't
    // show two different numbers (they previously used two different constants).
    const hoursSaved = estimateHoursSaved(posts);

    let topPost: TopPost | null = null;
    if (topPostRes.rows.length > 0) {
      const tp = topPostRes.rows[0];
      topPost = {
        title:       tp.title || 'Untitled',
        platform:    tp.platform,
        metric:      Number(tp.total_reach),
        metricLabel: getReachLabel(tp.platform),
      };
    }

    return {
      platform,
      period,
      posts,
      postsLabel:          getPostsLabel(platform),
      reach,
      reachPrev,
      reachDelta:          pctDelta(reach, reachPrev),
      reachLabel:          getReachLabel(platform),
      engagementRate,
      engagementRatePrev,
      comments:            commentsTotal,
      unreplied,
      hoursSaved,
      topPost,
      watchTimeMinutes:    includeWatchTime(platform) ? watchTime : null,
      // S3-1: "enough data" requires measurable reach or engagement — a post with
      // zero reach and zero engagement is "not enough data yet" (near-dead), not a
      // summarizable period. Previously `posts > 0` let a 0-reach post render a
      // fabricated ~50 Aries Score instead of the empty state.
      hasData:             reach > 0 || engagementRate > 0,
    };
  } finally {
    client.release();
  }
}
