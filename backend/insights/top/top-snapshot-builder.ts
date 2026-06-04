/**
 * backend/insights/top/top-snapshot-builder.ts
 *
 * Fetches the top-performing posts for Section 6.
 * All queries sequential (DB_POOL_MAX guardrail — no Promise.all on DB calls).
 *
 * Returns up to 5 posts (Aries-generated only), sorted by the requested metric,
 * each decorated with per-post sentiment, reach-vs-average multiplier, and the
 * best-performing day-of-week (used by the template builder for "why it worked").
 *
 * followerSplit and per-post audience are read from platform_data JSONB when
 * present (Instagram only) and returned null otherwise — the frontend hides
 * those rows when null.
 */

import pool from '@/lib/db';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

export type TopSortKey = 'reach' | 'engagement' | 'saves' | 'shares' | 'comments';

const VALID_SORTS = new Set<string>(['reach', 'engagement', 'saves', 'shares', 'comments']);

export function isValidSort(s: string | null): s is TopSortKey {
  return s != null && VALID_SORTS.has(s);
}

export interface PostSentiment {
  positive: number;   // %
  neutral:  number;   // %
  negative: number;   // %
}

export interface TopPost {
  id:            number;
  platform:      string;
  title:         string | null;
  caption:       string | null;
  permalink:     string | null;
  publishedAt:   string;          // ISO
  dateLabel:     string;          // "May 4"
  contentType:   string | null;
  mediaType:     string;

  reach:         number;
  engagement:    number;          // %
  saves:         number;
  shares:        number;
  comments:      number;
  saveRate:      number;          // saves / reach * 100

  multiplier:    number;          // reach / period average (rounded to 1dp)
  bestDow:       string | null;   // day-of-week label this post was published

  sentiment:     PostSentiment | null;
  followerSplit: string | null;   // "62% / 38%" (IG only), null when unavailable
}

export interface TopSnapshot {
  posts:        TopPost[];
  avgReach:     number;   // period average reach (for the multiplier context)
  postCount:    number;   // total Aries posts in period (for "still calibrating")
  sortBy:       TopSortKey;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function periodDays(period: NarrativePeriod): number {
  if (period === 'week')  return 7;
  if (period === '30day') return 30;
  return 90;
}

function utcDayStart(daysAgo: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function fmtDow(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

// ORDER BY column for each sort key (engagement is computed, handled in JS).
function orderColumn(sortBy: TopSortKey): string {
  switch (sortBy) {
    case 'saves':    return 'saves';
    case 'shares':   return 'shares';
    case 'comments': return 'comments';
    default:         return 'reach';   // reach + engagement both start from reach order
  }
}

// Read a follower-split string out of platform_data JSONB if the platform
// reported follower vs non-follower reach (Instagram). Returns null otherwise.
function extractFollowerSplit(platformData: Record<string, unknown> | null): string | null {
  if (!platformData) return null;
  const fromFollowers    = Number(platformData['reach_from_followers']);
  const fromNonFollowers = Number(platformData['reach_from_non_followers']);
  if (!Number.isFinite(fromFollowers) || !Number.isFinite(fromNonFollowers)) return null;
  const total = fromFollowers + fromNonFollowers;
  if (total <= 0) return null;
  const followerPct = Math.round((fromFollowers / total) * 100);
  return `${followerPct}% / ${100 - followerPct}%`;
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildTopSnapshot(
  tenantId:  number,
  period:    NarrativePeriod,
  platform:  string,
  sortBy:    TopSortKey,
): Promise<TopSnapshot> {
  const days           = periodDays(period);
  const fromDate       = utcDayStart(days);
  const platformFilter = platform === 'all' ? null : platform;

  const client = await pool.connect();
  try {

    // ── 1. Period average reach (for the multiplier) ─────────────────────────
    const avgRes = await client.query<{ avg_reach: string | null; post_count: string }>(
      `WITH post_totals AS (
         SELECT
           p.id,
           COALESCE(SUM(COALESCE(m.reach, m.views, 0)), 0) AS total_reach
         FROM insights_posts p
         LEFT JOIN insights_post_metrics_daily m
                ON m.post_id = p.id AND m.tenant_id = p.tenant_id
         WHERE p.tenant_id     = $1
           AND p.published_at  >= $2
           AND p.aries_post_id IS NOT NULL
           AND ($3::text IS NULL OR p.platform = $3)
         GROUP BY p.id
       )
       SELECT AVG(total_reach) AS avg_reach, COUNT(*) AS post_count
       FROM post_totals`,
      [tenantId, fromDate, platformFilter],
    );
    const avgReach  = Number(avgRes.rows[0]?.avg_reach ?? 0);
    const postCount = Number(avgRes.rows[0]?.post_count ?? 0);

    // ── 2. Top posts with aggregated metrics ─────────────────────────────────
    const orderCol = orderColumn(sortBy);
    const postsRes = await client.query<{
      id:            number;
      platform:      string;
      title:         string | null;
      caption:       string | null;
      permalink:     string | null;
      published_at:  string;
      content_type:  string | null;
      media_type:    string;
      platform_data: Record<string, unknown> | null;
      reach:         string;
      likes:         string;
      comments:      string;
      saves:         string;
      shares:        string;
    }>(
      `WITH post_metrics AS (
         SELECT
           p.id,
           p.platform,
           p.title,
           p.caption,
           p.permalink,
           p.published_at,
           p.content_type,
           p.media_type,
           p.platform_data,
           COALESCE(SUM(COALESCE(m.reach, m.views, 0)), 0) AS reach,
           COALESCE(SUM(COALESCE(m.likes, 0)), 0)          AS likes,
           COALESCE(SUM(COALESCE(m.comments_count, 0)), 0) AS comments,
           COALESCE(SUM(COALESCE(m.saves, 0)), 0)          AS saves,
           COALESCE(SUM(COALESCE(m.shares, 0)), 0)         AS shares
         FROM insights_posts p
         LEFT JOIN insights_post_metrics_daily m
                ON m.post_id = p.id AND m.tenant_id = p.tenant_id
         WHERE p.tenant_id     = $1
           AND p.published_at  >= $2
           AND p.aries_post_id IS NOT NULL
           AND ($3::text IS NULL OR p.platform = $3)
         GROUP BY p.id, p.platform, p.title, p.caption, p.permalink,
                  p.published_at, p.content_type, p.media_type, p.platform_data
       )
       SELECT *
       FROM post_metrics
       ORDER BY ${orderCol} DESC
       LIMIT 10`,
      [tenantId, fromDate, platformFilter],
    );

    // ── 3. Per-post sentiment (single grouped query for the candidate set) ────
    const candidateIds = postsRes.rows.map(r => r.id);
    const sentimentByPost = new Map<number, PostSentiment>();

    if (candidateIds.length > 0) {
      const sentRes = await client.query<{
        post_id:  number;
        positive: string;
        neutral:  string;
        negative: string;
        total:    string;
      }>(
        `SELECT
           c.post_id,
           COUNT(*) FILTER (WHERE cc.sentiment = 'positive') AS positive,
           COUNT(*) FILTER (WHERE cc.sentiment = 'neutral')  AS neutral,
           COUNT(*) FILTER (WHERE cc.sentiment = 'negative') AS negative,
           COUNT(*)                                          AS total
         FROM insights_comments c
         JOIN insights_comment_classifications cc ON cc.comment_id = c.id
         WHERE c.tenant_id = $1
           AND c.post_id   = ANY($2::bigint[])
         GROUP BY c.post_id`,
        [tenantId, candidateIds],
      );

      for (const r of sentRes.rows) {
        const total = Number(r.total);
        if (total === 0) continue;
        sentimentByPost.set(Number(r.post_id), {
          positive: Math.round((Number(r.positive) / total) * 100),
          neutral:  Math.round((Number(r.neutral)  / total) * 100),
          negative: Math.round((Number(r.negative) / total) * 100),
        });
      }
    }

    // ── 4. Assemble + compute engagement, multiplier, sort finalize ───────────
    let posts: TopPost[] = postsRes.rows.map(row => {
      const reach    = Number(row.reach);
      const likes    = Number(row.likes);
      const comments = Number(row.comments);
      const saves    = Number(row.saves);
      const shares   = Number(row.shares);
      const interactions = likes + comments + saves + shares;
      const engagement   = reach > 0 ? Math.round((interactions / reach) * 1000) / 10 : 0;
      const saveRate     = reach > 0 ? Math.round((saves / reach) * 10000) / 100 : 0;
      const multiplier   = avgReach > 0 ? Math.round((reach / avgReach) * 10) / 10 : 0;

      return {
        id:            row.id,
        platform:      row.platform,
        title:         row.title,
        caption:       row.caption,
        permalink:     row.permalink,
        publishedAt:   new Date(row.published_at).toISOString(),
        dateLabel:     fmtDate(row.published_at),
        contentType:   row.content_type,
        mediaType:     row.media_type,
        reach,
        engagement,
        saves,
        shares,
        comments,
        saveRate,
        multiplier,
        bestDow:       fmtDow(row.published_at),
        sentiment:     sentimentByPost.get(row.id) ?? null,
        followerSplit: extractFollowerSplit(row.platform_data),
      };
    });

    // Engagement sort is computed in JS (not a DB column); re-sort when requested.
    if (sortBy === 'engagement') {
      posts.sort((a, b) => b.engagement - a.engagement);
    }

    posts = posts.slice(0, 5);

    return { posts, avgReach, postCount, sortBy };

  } finally {
    client.release();
  }
}
