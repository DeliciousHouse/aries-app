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
import { LATEST_POST_METRICS_LATERAL } from '../latest-post-metrics-sql';
import { resolveTenantInsightsTimeZone } from '../tenant-timezone';
import { tenantZonePeriodStart } from '@/lib/format-timestamp';

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

// S2-3: a post's date label and best-weekday render in the tenant's business
// timezone, not UTC — so a post published late-evening tenant-time is not labelled
// with the next UTC day / weekday (which contradicted the tenant-tz DOW analysis).
function fmtDate(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz });
}

function fmtDow(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
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

/**
 * Per-post derived metrics from the LATEST-snapshot raw counts (S2-1) and the
 * period average reach. Pinned by tests/insights-math-pinning.test.ts (S2-5).
 *   engagement = (likes+comments+saves+shares)/reach, as a % to 1 decimal
 *   saveRate   = saves/reach, as a % to 2 decimals
 *   multiplier = reach / period-average-reach, to 1 decimal ("Nx average")
 * Each guards its divisor: reach<=0 → engagement/saveRate 0; avgReach<=0 → multiplier 0.
 */
export interface TopPostMetrics { engagement: number; saveRate: number; multiplier: number }
export function deriveTopPostMetrics(
  raw: { reach: number; likes: number; comments: number; saves: number; shares: number },
  avgReach: number,
): TopPostMetrics {
  const interactions = raw.likes + raw.comments + raw.saves + raw.shares;
  return {
    engagement: raw.reach > 0 ? Math.round((interactions / raw.reach) * 1000) / 10 : 0,
    saveRate:   raw.reach > 0 ? Math.round((raw.saves / raw.reach) * 10000) / 100 : 0,
    multiplier: avgReach > 0 ? Math.round((raw.reach / avgReach) * 10) / 10 : 0,
  };
}

/**
 * Final top-N ordering. Behavior-identical to the pre-S2-5 inline logic (pinned
 * by S2-5): engagement is a JS-computed column so it is re-sorted here (desc);
 * every other sort key trusts the incoming DB `ORDER BY <col> DESC` order. Then
 * the top 5 are returned. NO tie-breaker — exact-metric ties keep the input
 * (DB/insertion) order, which is NOT deterministic; a follow-up ticket should add
 * an id-asc tie-breaker (and only then pin exact tie order).
 */
export function rankTopPosts<T extends { engagement: number }>(posts: T[], sortBy: TopSortKey): T[] {
  const ranked = sortBy === 'engagement'
    ? [...posts].sort((a, b) => b.engagement - a.engagement)
    : [...posts];
  return ranked.slice(0, 5);
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
  const platformFilter = platform === 'all' ? null : platform;

  const client = await pool.connect();
  try {
    // S2-3: window filters published_at (timestamptz) → tenant-tz-midnight instant.
    const tz       = await resolveTenantInsightsTimeZone(client, tenantId);
    const fromDate = tenantZonePeriodStart(days, tz);

    // ── 1. Period average reach (for the multiplier) ─────────────────────────
    const avgRes = await client.query<{ avg_reach: string | null; post_count: string }>(
      `WITH post_totals AS (
         SELECT
           p.id,
           -- S2-1: latest lifetime snapshot per post, NOT SUM across dated rows.
           COALESCE(m.reach, m.views, 0) AS total_reach
         FROM insights_posts p
         ${LATEST_POST_METRICS_LATERAL}
         WHERE p.tenant_id     = $1
           AND p.published_at  >= $2
           AND ($3::text IS NULL OR p.platform = $3)
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
           -- S2-1: latest lifetime snapshot per post, NOT SUM across dated rows
           -- (each daily row is a cumulative all-time total → SUM inflated ~N×).
           COALESCE(m.reach, m.views, 0) AS reach,
           COALESCE(m.likes, 0)          AS likes,
           COALESCE(m.comments_count, 0) AS comments,
           COALESCE(m.saves, 0)          AS saves,
           COALESCE(m.shares, 0)         AS shares
         FROM insights_posts p
         ${LATEST_POST_METRICS_LATERAL}
         WHERE p.tenant_id     = $1
           AND p.published_at  >= $2
           AND ($3::text IS NULL OR p.platform = $3)
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
      const { engagement, saveRate, multiplier } = deriveTopPostMetrics(
        { reach, likes, comments, saves, shares },
        avgReach,
      );

      return {
        id:            Number(row.id),
        platform:      row.platform,
        title:         row.title,
        caption:       row.caption,
        permalink:     row.permalink,
        publishedAt:   new Date(row.published_at).toISOString(),
        dateLabel:     fmtDate(row.published_at, tz),
        contentType:   row.content_type,
        mediaType:     row.media_type,
        reach,
        engagement,
        saves,
        shares,
        comments,
        saveRate,
        multiplier,
        bestDow:       fmtDow(row.published_at, tz),
        sentiment:     sentimentByPost.get(Number(row.id)) ?? null,
        followerSplit: extractFollowerSplit(row.platform_data),
      };
    });

    // Final ordering + top-5 trim (extracted to rankTopPosts, pinned by S2-5).
    // Engagement is a JS-computed column so it is re-sorted here; other keys trust
    // the DB ORDER BY. Behavior-identical to the previous inline logic.
    posts = rankTopPosts(posts, sortBy);

    return { posts, avgReach, postCount, sortBy };

  } finally {
    client.release();
  }
}
