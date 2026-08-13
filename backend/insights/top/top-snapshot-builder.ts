/**
 * backend/insights/top/top-snapshot-builder.ts
 *
 * Fetches the top-performing posts for Section 6.
 * All queries sequential (DB_POOL_MAX guardrail — no Promise.all on DB calls).
 *
 * Returns up to 5 posts, sorted by the requested metric, each decorated with
 * per-post sentiment, reach-vs-average multiplier, and the best-performing
 * day-of-week (used by the template builder for "why it worked").
 *
 * S4-1: the candidate set is Aries-published posts when the window's attribution
 * coverage is trustworthy and all channel posts otherwise (#785's behavior).
 * See attribution-scope.ts for why the fallback is mandatory.
 *
 * followerSplit and per-post audience are read from platform_data JSONB when
 * present (Instagram only) and returned null otherwise — the frontend hides
 * those rows when null.
 */

import type { PoolClient } from '@/lib/db';
import type { NarrativePeriod } from '../narrative/snapshot-builder';
import { LATEST_POST_METRICS_LATERAL } from '../latest-post-metrics-sql';
import { resolveTenantInsightsTimeZone } from '../tenant-timezone';
import { tenantZonePeriodStart } from '@/lib/format-timestamp';
import { resolveAttributionScope, type AttributionScopeResult } from '../attribution-scope';
import { postEngagementPercent, POST_ENGAGEMENT_PERCENT_SQL } from '../post-engagement-percent';

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

// AA-229/PR2a — reduced projection for the weakest-post card. Deliberately NOT
// the full `TopPost` shape: the weakest-post query only ever selects 7 columns
// (see buildWeakestPost below), so populating sentiment/multiplier/saveRate/
// bestDow/etc. here would mean fabricating fields nothing computed — the exact
// "confidently-wrong number" failure mode this section already guards against
// elsewhere (S3-1/AA-97 honesty pass).
export interface WeakestPost {
  id:        number;
  platform:  string;
  title:     string | null;
  caption:   string | null;
  permalink: string | null;
  reach:     number;
  /** The active sort metric's raw value for this post (a count, or a % for engagement). */
  metric:    number;
}

// AA-229/PR2a — why the ranked set is empty, reusing the exact semantics of
// INSIGHTS_AVAILABILITY_SQL (backend/marketing/weekly-results-report.ts): an
// `insights_accounts` row exists (that table has no `status` column — row
// existence IS connectedness) AND at least one joined
// `insights_post_metrics_daily` row landed in the window. `reason` is null
// when the ranked set is populated (cheap default — see deriveTopAvailability
// callers) and only takes on the two documented values once the extra
// availability query has actually run.
export interface TopAvailability {
  insightsConnected: boolean;
  reason: 'insights_not_connected' | 'no_posts_in_window' | null;
}

export interface TopSnapshot {
  posts:        TopPost[];
  avgReach:     number;   // period average reach (for the multiplier context)
  postCount:    number;   // posts in the scoped period set (for "still calibrating")
  sortBy:       TopSortKey;
  attribution:  AttributionScopeResult;
  weakest:      WeakestPost | null;
  availability: TopAvailability;
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

// SQL ORDER BY expression for the weakest-post query — same column names as
// orderColumn() for reach/saves/shares/comments, but the shared
// POST_ENGAGEMENT_PERCENT_SQL formula (not the 'reach' placeholder
// orderColumn() returns) for engagement, so the weakest-post ranking and the
// deriveTopPostMetrics() ranking below can never silently diverge.
function weakestOrderExpr(sortBy: TopSortKey): string {
  return sortBy === 'engagement' ? POST_ENGAGEMENT_PERCENT_SQL : orderColumn(sortBy);
}

// AA-229/PR2a — with fewer than 2 posts in the scoped set, the single post IS
// both the best and the weakest post; showing a "weakest post" card next to an
// identical "best post" card inside a top-5 list reads as a bug, so the card
// is omitted entirely rather than showing a misleading duplicate.
export function shouldComputeWeakest(postCount: number): boolean {
  return postCount >= 2;
}

// AA-229/PR2a — reuses the exact semantics of INSIGHTS_AVAILABILITY_SQL
// (backend/marketing/weekly-results-report.ts): connectedness is an
// `insights_accounts` row existing; "actually usable" additionally requires
// at least one synced metric row in the window. Pure so the reason mapping is
// unit-testable without a DB.
export function deriveTopAvailability(accountCount: number, metricRowCount: number): TopAvailability {
  const insightsConnected = accountCount > 0 && metricRowCount > 0;
  return {
    insightsConnected,
    reason: insightsConnected ? 'no_posts_in_window' : 'insights_not_connected',
  };
}

/**
 * Per-post derived metrics from the LATEST-snapshot raw counts (S2-1) and the
 * period average reach. Pinned by tests/insights-math-pinning.test.ts (S2-5).
 *   engagement = (likes+comments+saves+shares)/reach, as a % to 1 decimal —
 *                delegates to postEngagementPercent() (post-engagement-percent.ts),
 *                the single JS implementation shared with the weakest-post
 *                query's SQL ORDER BY expression (AA-229/PR2a).
 *   saveRate   = saves/reach, as a % to 2 decimals
 *   multiplier = reach / period-average-reach, to 1 decimal ("Nx average")
 * Each guards its divisor: reach<=0 → engagement/saveRate 0; avgReach<=0 → multiplier 0.
 */
export interface TopPostMetrics { engagement: number; saveRate: number; multiplier: number }
export function deriveTopPostMetrics(
  raw: { reach: number; likes: number; comments: number; saves: number; shares: number },
  avgReach: number,
): TopPostMetrics {
  return {
    engagement: postEngagementPercent(raw),
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
  /** AA-122: supplied by the handler, which already holds a pooled client.
   * The builder must not acquire (or release) a second one. */
  client:   PoolClient,
): Promise<TopSnapshot> {
  const days           = periodDays(period);
  const platformFilter = platform === 'all' ? null : platform;

  // S2-3: window filters published_at (timestamptz) → tenant-tz-midnight instant.
  const tz       = await resolveTenantInsightsTimeZone(client, tenantId);
  const fromDate = tenantZonePeriodStart(days, tz);

  // S4-1: decided once so the average, the post count and the ranked list all
  // describe the same set — a multiplier against a different baseline lies.
  const attribution = await resolveAttributionScope({
    db: client,
    tenantId,
    fromDate,
    platformFilter,
  });
  const attributedOnly = attribution.attributedOnly;

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
         AND ($4::boolean IS NOT TRUE OR p.aries_post_id IS NOT NULL)
     )
     SELECT AVG(total_reach) AS avg_reach, COUNT(*) AS post_count
     FROM post_totals`,
    [tenantId, fromDate, platformFilter, attributedOnly],
  );
  const avgReach  = Number(avgRes.rows[0]?.avg_reach ?? 0);
  const postCount = Number(avgRes.rows[0]?.post_count ?? 0);

  // ── 2. Weakest post (AA-229/PR2a) ─────────────────────────────────────────
  // Deliberately a SEPARATE query, not `.at(-1)` of the top-10 candidate list
  // below: that list is `ORDER BY … DESC LIMIT 10`, so its last element is the
  // 10th-BEST post, not the weakest. Skipped entirely below 2 posts, where
  // best === weakest and a duplicate card would read as a bug.
  let weakest: WeakestPost | null = null;
  if (shouldComputeWeakest(postCount)) {
    const weakestOrderCol = weakestOrderExpr(sortBy);
    const weakestRes = await client.query<{
      id:        number;
      platform:  string;
      title:     string | null;
      caption:   string | null;
      permalink: string | null;
      reach:     string;
      metric:    string;
    }>(
      `WITH post_metrics AS (
         SELECT
           p.id,
           p.platform,
           p.title,
           p.caption,
           p.permalink,
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
           AND ($4::boolean IS NOT TRUE OR p.aries_post_id IS NOT NULL)
       )
       SELECT id, platform, title, caption, permalink, reach, ${weakestOrderCol} AS metric
       FROM post_metrics
       ORDER BY ${weakestOrderCol} ASC
       LIMIT 1`,
      [tenantId, fromDate, platformFilter, attributedOnly],
    );
    const row = weakestRes.rows[0];
    if (row) {
      weakest = {
        id:        Number(row.id),
        platform:  row.platform,
        title:     row.title,
        caption:   row.caption,
        permalink: row.permalink,
        reach:     Number(row.reach),
        metric:    Number(row.metric),
      };
    }
  }

  // ── 3. Availability (AA-229/PR2a) ─────────────────────────────────────────
  // Only costs a query when the ranked set is actually empty (postCount === 0
  // ⟺ posts.length === 0, since postsRes below shares this exact predicate).
  // The populated path gets the cheap default with no extra round trip.
  let availability: TopAvailability = { insightsConnected: true, reason: null };
  if (postCount === 0) {
    const availRes = await client.query<{ account_count: string; metric_row_count: string }>(
      `SELECT
         (SELECT count(*) FROM insights_accounts WHERE tenant_id = $1)::int AS account_count,
         (SELECT count(*)
            FROM insights_posts p
            JOIN insights_post_metrics_daily d
              ON d.post_id = p.id AND d.tenant_id = p.tenant_id
           WHERE p.tenant_id = $1
             AND p.published_at >= $2)::int AS metric_row_count`,
      [tenantId, fromDate],
    );
    const accountCount   = Number(availRes.rows[0]?.account_count ?? 0);
    const metricRowCount = Number(availRes.rows[0]?.metric_row_count ?? 0);
    availability = deriveTopAvailability(accountCount, metricRowCount);
  }

  // ── 4. Top posts with aggregated metrics ─────────────────────────────────
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
         AND ($4::boolean IS NOT TRUE OR p.aries_post_id IS NOT NULL)
     )
     SELECT *
     FROM post_metrics
     ORDER BY ${orderCol} DESC
     LIMIT 10`,
    [tenantId, fromDate, platformFilter, attributedOnly],
  );

  // ── 5. Per-post sentiment (single grouped query for the candidate set) ────
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

  // ── 6. Assemble + compute engagement, multiplier, sort finalize ───────────
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

  return { posts, avgReach, postCount, sortBy, attribution, weakest, availability };

}
