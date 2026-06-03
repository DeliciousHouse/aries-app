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
  postsLabel: string;       // 'post' | 'video' | platform-specific
  reach: number;
  reachPrev: number;
  reachDelta: number;       // % change vs previous equivalent period
  reachLabel: string;       // 'people' | 'unique viewers' | 'impressions'
  engagementRate: number;   // (likes+comments+shares)/reach*100
  topPost: TopPost | null;
  unreplied: number;
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

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
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
  const fromDate      = daysAgo(days);
  const prevFrom      = daysAgo(days * 2);
  const platformFilter = platform === 'all' ? null : platform;

  const client = await pool.connect();
  try {
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
         AND date >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    );

    // Previous period reach (for delta calculation)
    const prevRes = await client.query<{ reach: string }>(
      `SELECT COALESCE(SUM(COALESCE(reach, views, 0)), 0) AS reach
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2
         AND date < $3
         AND ($4::text IS NULL OR platform = $4)`,
      [tenantId, prevFrom, fromDate, platformFilter],
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
         COALESCE(SUM(COALESCE(m.reach, m.views, 0)), 0) AS total_reach
       FROM insights_posts p
       LEFT JOIN insights_post_metrics_daily m
              ON m.post_id = p.id AND m.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1
         AND p.published_at >= $2
         AND ($3::text IS NULL OR p.platform = $3)
       GROUP BY p.id, p.title, p.platform
       ORDER BY total_reach DESC
       LIMIT 1`,
      [tenantId, fromDate, platformFilter],
    );

    // Unreplied comments received in period
    const unrepliedRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM insights_comments
       WHERE tenant_id = $1
         AND received_at >= $2
         AND is_replied = false
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    );

    // ── Assemble snapshot ────────────────────────────────────────────────────
    const m         = metricsRes.rows[0];
    const reach     = Number(m.reach);
    const reachPrev = Number(prevRes.rows[0].reach);
    const likes     = Number(m.likes);
    const comments  = Number(m.comments_count);
    const shares    = Number(m.shares);
    const watchTime = Number(m.watch_time_minutes);
    const posts     = Number(postCountRes.rows[0].count);
    const unreplied = Number(unrepliedRes.rows[0].count);

    const engagementRate = reach > 0
      ? Math.round(((likes + comments + shares) / reach) * 10000) / 100
      : 0;

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
      postsLabel:       getPostsLabel(platform),
      reach,
      reachPrev,
      reachDelta:       pctDelta(reach, reachPrev),
      reachLabel:       getReachLabel(platform),
      engagementRate,
      topPost,
      unreplied,
      watchTimeMinutes: includeWatchTime(platform) ? watchTime : null,
      hasData:          posts > 0 || reach > 0,
    };
  } finally {
    client.release();
  }
}
