/**
 * backend/insights/attention/attention-snapshot-builder.ts
 *
 * Fetches the raw data needed to build the "Worth Your Attention" cards.
 * Queries are run sequentially (DB_POOL_MAX guardrail — no Promise.all on DB calls).
 *
 * Three data domains:
 *   A) Unreplied comments — count + classification hints (leads, questions)
 *   B) High performer — top post vs period average (show when ≥2x)
 *   C) Pattern — day-of-week outperformance or cross-platform outperformance
 *      Milestone — follower threshold crossed this period (1K/5K/10K/25K/50K/100K)
 */

import pool from '@/lib/db';
import { LATEST_POST_METRICS_LATERAL } from '../latest-post-metrics-sql';
import { resolveTenantInsightsTimeZone } from '../tenant-timezone';
import { tenantZonePeriodStart, tenantZonePeriodStartDateKey } from '@/lib/format-timestamp';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

export interface HighPerformer {
  title:       string;
  platform:    string;
  totalReach:  number;
  avgReach:    number;
  multiplier:  number;   // totalReach / avgReach, pre-computed
}

export type PatternType = 'day_of_week' | 'platform_outperformance';

export interface ContentPattern {
  type:     PatternType;
  dayName?: string;      // for day_of_week
  mult?:    number;      // how many times better
  topPlatform?: string;  // for platform_outperformance
  secPlatform?: string;
}

export interface FollowerMilestone {
  value:    number;   // milestone crossed (e.g. 10000)
  platform: string;
}

export interface AttentionSnapshot {
  // Card A
  unreplied:          number;
  unrepliedLeads:     number;
  unrepliedQuestions: number;

  // Card B
  highPerformer:  HighPerformer | null;

  // Card C
  pattern:        ContentPattern | null;
  milestone:      FollowerMilestone | null;

  postCount:      number;   // for "still calibrating" guard
}

// ── Period helpers ─────────────────────────────────────────────────────────────

function periodDays(period: NarrativePeriod): number {
  if (period === 'week')  return 7;
  if (period === '30day') return 30;
  return 90;
}

// Exported for the S2-4 day-boundary tz-agreement test (tests/insights-tz-boundary-agreement.test.ts).
export const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const FOLLOWER_MILESTONES = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

function crossedMilestone(start: number, end: number): number | null {
  for (const m of FOLLOWER_MILESTONES) {
    if (start < m && end >= m) return m;
  }
  return null;
}

function fmtMilestone(n: number): string {
  if (n >= 1000) return `${n / 1000}K`;
  return String(n);
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildAttentionSnapshot(
  tenantId:  number,
  period:    NarrativePeriod,
  platform:  string,
): Promise<AttentionSnapshot> {
  const days           = periodDays(period);
  const platformFilter = platform === 'all' ? null : platform;

  const client = await pool.connect();
  try {
    // S2-3: windows + day-of-week bucketing in the tenant's business timezone.
    // timestamptz columns (received_at / published_at) use the tenant-tz-midnight
    // instant; the two account-daily (bare DATE) sub-queries use a tenant-tz
    // calendar date ($n::date).
    const tz       = await resolveTenantInsightsTimeZone(client, tenantId);
    const fromDate = tenantZonePeriodStart(days, tz);
    const fromKey  = tenantZonePeriodStartDateKey(days, tz);

    // ── A: Unreplied comments + classification hints ──────────────────────────
    const unrepliedRes = await client.query<{
      total_unreplied:    string;
      unreplied_leads:    string;
      unreplied_questions: string;
    }>(
      `SELECT
         COUNT(*)                                                          AS total_unreplied,
         COUNT(*) FILTER (WHERE cc.is_lead = true)                        AS unreplied_leads,
         COUNT(*) FILTER (WHERE cc.category = 'question')                 AS unreplied_questions
       FROM insights_comments c
       LEFT JOIN insights_comment_classifications cc ON cc.comment_id = c.id
       WHERE c.tenant_id  = $1
         AND c.received_at >= $2
         AND c.is_replied  = false
         AND ($3::text IS NULL OR c.platform = $3)`,
      [tenantId, fromDate, platformFilter],
    );

    const unreplied          = Number(unrepliedRes.rows[0].total_unreplied);
    const unrepliedLeads     = Number(unrepliedRes.rows[0].unreplied_leads);
    const unrepliedQuestions = Number(unrepliedRes.rows[0].unreplied_questions);

    // ── Post count (used for "still calibrating" guard) ───────────────────────
    const postCountRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM insights_posts
       WHERE tenant_id   = $1
         AND published_at >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, fromDate, platformFilter],
    );
    const postCount = Number(postCountRes.rows[0].count);

    // ── B: High performer (top post vs period average) ────────────────────────
    let highPerformer: HighPerformer | null = null;

    if (postCount > 0) {
      const hpRes = await client.query<{
        title:       string | null;
        platform:    string;
        total_reach: string;
        avg_reach:   string;
      }>(
        `WITH post_totals AS (
           SELECT
             p.id,
             p.title,
             p.platform,
             -- S2-1: latest lifetime snapshot per post, NOT SUM across dated rows.
             COALESCE(m.reach, m.views, 0) AS total_reach
           FROM insights_posts p
           ${LATEST_POST_METRICS_LATERAL}
           WHERE p.tenant_id    = $1
             AND p.published_at >= $2
             AND ($3::text IS NULL OR p.platform = $3)
         )
         SELECT
           title,
           platform,
           total_reach,
           AVG(total_reach) OVER () AS avg_reach
         FROM post_totals
         ORDER BY total_reach DESC
         LIMIT 1`,
        [tenantId, fromDate, platformFilter],
      );

      if (hpRes.rows.length > 0) {
        const row       = hpRes.rows[0];
        const total     = Number(row.total_reach);
        const avg       = Number(row.avg_reach);
        const mult      = avg > 0 ? Math.round((total / avg) * 10) / 10 : 0;
        if (mult >= 2) {
          highPerformer = {
            title:      row.title || 'Untitled',
            platform:   row.platform,
            totalReach: total,
            avgReach:   avg,
            multiplier: mult,
          };
        }
      }
    }

    // ── C: Pattern — day-of-week outperformance ───────────────────────────────
    let pattern: ContentPattern | null = null;

    if (postCount >= 4) {
      const dowRes = await client.query<{
        dow:       string;
        avg_reach: string;
        cnt:       string;
      }>(
        // S2-1: average each post's LATEST lifetime reach per weekday (and count
        // posts, not dated rows). The old direct join fanned out per date row, so
        // AVG/COUNT were over cumulative snapshots, not posts.
        // S2-3: weekday derived in the tenant's business timezone ($4), not UTC —
        // this is the flagship "best day to post" coherence fix.
        `SELECT dow, AVG(reach) AS avg_reach, COUNT(*) AS cnt
         FROM (
           SELECT EXTRACT(DOW FROM p.published_at AT TIME ZONE $4)::int AS dow,
                  COALESCE(m.reach, m.views, 0)                          AS reach
           FROM insights_posts p
           ${LATEST_POST_METRICS_LATERAL}
           WHERE p.tenant_id    = $1
             AND p.published_at >= $2
             AND ($3::text IS NULL OR p.platform = $3)
         ) per_post
         GROUP BY dow
         HAVING COUNT(*) >= 2
         ORDER BY avg_reach DESC`,
        [tenantId, fromDate, platformFilter, tz],
      );

      if (dowRes.rows.length >= 2) {
        const best  = Number(dowRes.rows[0].avg_reach);
        const total = dowRes.rows.reduce((s, r) => s + Number(r.avg_reach), 0);
        const overallAvg = total / dowRes.rows.length;
        const mult  = overallAvg > 0 ? Math.round((best / overallAvg) * 10) / 10 : 0;
        if (mult >= 1.5) {
          pattern = {
            type:    'day_of_week',
            dayName: DOW_NAMES[Number(dowRes.rows[0].dow)] ?? 'weekend',
            mult,
          };
        }
      }

      // Platform outperformance (all-channels view only)
      if (!pattern && platform === 'all') {
        const platRes = await client.query<{
          platform:  string;
          avg_reach: string;
        }>(
          // S2-3: bare DATE column bounded by a tenant-tz calendar date ($2::date).
          `SELECT
             platform,
             AVG(COALESCE(reach, views, 0)) AS avg_reach
           FROM insights_account_metrics_daily
           WHERE tenant_id = $1
             AND date >= $2::date
           GROUP BY platform
           HAVING COUNT(DISTINCT date) >= 3
           ORDER BY avg_reach DESC`,
          [tenantId, fromKey],
        );

        if (platRes.rows.length >= 2) {
          const top = Number(platRes.rows[0].avg_reach);
          const sec = Number(platRes.rows[1].avg_reach);
          const mult = sec > 0 ? Math.round((top / sec) * 10) / 10 : 0;
          if (mult >= 1.5) {
            pattern = {
              type:        'platform_outperformance',
              topPlatform: platRes.rows[0].platform,
              secPlatform: platRes.rows[1].platform,
              mult,
            };
          }
        }
      }
    }

    // ── C: Milestone — follower threshold crossed this period ─────────────────
    let milestone: FollowerMilestone | null = null;

    const milestoneRes = await client.query<{
      platform:         string;
      start_followers:  string | null;
      end_followers:    string | null;
    }>(
      // S2-3: bare DATE column bounded by a tenant-tz calendar date ($2::date).
      `SELECT
         platform,
         MIN(followers) AS start_followers,
         MAX(followers) AS end_followers
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date >= $2::date
         AND followers IS NOT NULL
         AND ($3::text IS NULL OR platform = $3)
       GROUP BY platform`,
      [tenantId, fromKey, platformFilter],
    );

    for (const row of milestoneRes.rows) {
      const start = Number(row.start_followers ?? 0);
      const end   = Number(row.end_followers   ?? 0);
      const ms    = crossedMilestone(start, end);
      if (ms) {
        milestone = { value: ms, platform: row.platform };
        break;
      }
    }

    return {
      unreplied,
      unrepliedLeads,
      unrepliedQuestions,
      highPerformer,
      pattern,
      milestone,
      postCount,
    };

  } finally {
    client.release();
  }
}

export { fmtMilestone };
