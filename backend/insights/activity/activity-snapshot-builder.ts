/**
 * backend/insights/activity/activity-snapshot-builder.ts
 *
 * Fetches the raw numbers for Section 4 — "What Aries Did".
 * All queries are sequential (DB_POOL_MAX guardrail — no Promise.all on DB calls).
 *
 * Activity strip:
 *   - postsPublished   — all posts published on connected channels in the period
 *   - commentsReceived — comments received on those posts
 *   - highPerformers   — posts that hit ≥2x the period average reach (same
 *                        baseline logic as the Section 3 opportunity card)
 *   - hoursSaved       — formula: postsPublished × HOURS_PER_POST
 *   - platformCount    — distinct platforms for the footer line
 *
 * Content mix:
 *   - array of { contentType, count, pct } ordered by count DESC
 *   - NULL content_type rows grouped as 'uncategorized'
 *   - pendingClassification count included for frontend nudge
 */

import pool from '@/lib/db';
import { LATEST_POST_METRICS_LATERAL } from '../latest-post-metrics-sql';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

// Conservative estimate: research + writing + creative + scheduling per post.
const HOURS_PER_POST = 3;

export interface ContentMixSlice {
  contentType: string;   // 'uncategorized' when content_type IS NULL
  count:       number;
  pct:         number;   // 0–100, rounded to 1 decimal
}

export interface ActivitySnapshot {
  postsPublished:         number;
  commentsReceived:       number;
  commentsHandled:        number;   // is_replied = true
  commentsNeedReply:      number;   // is_replied = false
  highPerformers:         number;
  hoursSaved:             number;
  platformCount:          number;
  platforms:              string[]; // distinct platforms the posts went out on
  contentMix:             ContentMixSlice[];
  pendingClassification:  number;   // rows where content_type IS NULL
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

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildActivitySnapshot(
  tenantId:  number,
  period:    NarrativePeriod,
  platform:  string,
): Promise<ActivitySnapshot> {
  const days           = periodDays(period);
  const fromDate       = daysAgo(days);
  const platformFilter = platform === 'all' ? null : platform;

  const client = await pool.connect();
  try {

    // ── Posts published + platform count ─────────────────────────────────────
    const postsRes = await client.query<{
      post_count:     string;
      platform_count: string;
      platforms:      string[] | null;
    }>(
      `SELECT
         COUNT(*)                    AS post_count,
         COUNT(DISTINCT platform)    AS platform_count,
         array_agg(DISTINCT platform) AS platforms
       FROM insights_posts
       WHERE tenant_id      = $1
         AND published_at   >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    );

    const postsPublished = Number(postsRes.rows[0].post_count);
    const platformCount  = Number(postsRes.rows[0].platform_count);
    const platforms      = (postsRes.rows[0].platforms ?? []).filter((p): p is string => p != null);

    // ── Comments received (+ handled / needs-reply split) ─────────────────────
    const commentsRes = await client.query<{ count: string; needs_reply: string }>(
      `SELECT
         COUNT(*)                                       AS count,
         COUNT(*) FILTER (WHERE c.is_replied = false)   AS needs_reply
       FROM insights_comments c
       JOIN insights_posts p ON p.id = c.post_id
       WHERE c.tenant_id     = $1
         AND c.received_at   >= $2
         AND ($3::text IS NULL OR c.platform = $3)`,
      [tenantId, fromDate, platformFilter],
    );

    const commentsReceived  = Number(commentsRes.rows[0].count);
    const commentsNeedReply = Number(commentsRes.rows[0].needs_reply);
    const commentsHandled   = commentsReceived - commentsNeedReply;

    // ── High performers — posts ≥2x period average reach ─────────────────────
    // Mirrors the Section 3 detection so both sections agree.
    let highPerformers = 0;

    if (postsPublished > 0) {
      const hpRes = await client.query<{ hp_count: string }>(
        `WITH post_totals AS (
           SELECT
             p.id,
             -- S2-1: latest lifetime snapshot per post, NOT SUM across dated rows.
             COALESCE(m.reach, m.views, 0) AS total_reach
           FROM insights_posts p
           ${LATEST_POST_METRICS_LATERAL}
           WHERE p.tenant_id    = $1
             AND p.published_at >= $2
             AND ($3::text IS NULL OR p.platform = $3)
         ),
         avg_reach AS (
           SELECT AVG(total_reach) AS avg FROM post_totals
         )
         SELECT COUNT(*) AS hp_count
         FROM post_totals, avg_reach
         WHERE avg_reach.avg > 0
           AND post_totals.total_reach >= 2 * avg_reach.avg`,
        [tenantId, fromDate, platformFilter],
      );
      highPerformers = Number(hpRes.rows[0].hp_count);
    }

    // ── Content mix ───────────────────────────────────────────────────────────
    const mixRes = await client.query<{
      content_type: string | null;
      cnt:          string;
    }>(
      `SELECT
         COALESCE(content_type, 'uncategorized') AS content_type,
         COUNT(*) AS cnt
       FROM insights_posts
       WHERE tenant_id     = $1
         AND published_at  >= $2
         AND ($3::text IS NULL OR platform = $3)
       GROUP BY COALESCE(content_type, 'uncategorized')
       ORDER BY cnt DESC`,
      [tenantId, fromDate, platformFilter],
    );

    const totalPosts = mixRes.rows.reduce((s, r) => s + Number(r.cnt), 0);

    const contentMix: ContentMixSlice[] = mixRes.rows.map(r => {
      const count = Number(r.cnt);
      return {
        contentType: r.content_type ?? 'uncategorized',
        count,
        pct: totalPosts > 0 ? Math.round((count / totalPosts) * 1000) / 10 : 0,
      };
    });

    // How many posts are still awaiting content-type classification
    const pendingRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM insights_posts
       WHERE tenant_id     = $1
         AND published_at  >= $2
         AND content_type  IS NULL
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    );
    const pendingClassification = Number(pendingRes.rows[0].count);

    return {
      postsPublished,
      commentsReceived,
      commentsHandled,
      commentsNeedReply,
      highPerformers,
      hoursSaved:   postsPublished * HOURS_PER_POST,
      platformCount,
      platforms,
      contentMix,
      pendingClassification,
    };

  } finally {
    client.release();
  }
}
