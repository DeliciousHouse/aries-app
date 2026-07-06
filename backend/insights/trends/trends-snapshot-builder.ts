/**
 * backend/insights/trends/trends-snapshot-builder.ts
 *
 * Fetches all raw data for Section 5 — Performance Trends.
 * All queries sequential (DB_POOL_MAX guardrail — no Promise.all on DB calls).
 *
 * Returns per-metric totals, current+prior time-series, platform breakdowns,
 * and supporting context (unreplied, sentiment, top post) for template rendering.
 *
 * Bucketing:
 *   week   → 7 daily points
 *   30day  → 30 daily points
 *   90day  → ~13 weekly points (DATE_TRUNC week)
 *
 * Visits availability: profile_visits only exists for Instagram/Facebook.
 * visitsAvailable is false when the selected platform has no visit data.
 */

import pool from '@/lib/db';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrendsMetric {
  value:     number;
  valuePrev: number;
  delta:     number | null;   // % change vs prior; null for metrics where it's not shown
}

export interface TrendsSeries {
  current: number[];
  prior:   number[];
  labels:  string[];          // one per bucket (frontend applies tickAmount for density)
}

export interface PlatformSlice {
  platform: string;
  value:    number;
  pct:      number;
}

export interface TrendsSnapshot {
  reach:      TrendsMetric;
  engagement: TrendsMetric;   // value = engagement rate %
  followers:  TrendsMetric;
  comments:   TrendsMetric;
  visits:     TrendsMetric | null;

  series: {
    reach:      TrendsSeries;
    engagement: TrendsSeries;
    followers:  TrendsSeries;
    comments:   TrendsSeries;
    visits:     TrendsSeries | null;
  };

  platformBreakdown: {
    reach:      PlatformSlice[];
    engagement: PlatformSlice[];
    followers:  PlatformSlice[];
    comments:   PlatformSlice[];
    visits:     PlatformSlice[] | null;
  };

  // Context for template builder
  postCount:           number;
  unreplied:           number;
  sentimentPositivePct: number;
  topPostTitle:        string | null;
  engagementBaseline:  number;   // 90-day avg engagement rate (for key-movement benchmark)
  visitsAvailable:     boolean;
}

// ── Period / date helpers ─────────────────────────────────────────────────────

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

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function fmtDow(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

// Returns the Monday of the week containing d (UTC).
function weekStart(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const ws = new Date(d);
  ws.setUTCDate(ws.getUTCDate() + diff);
  ws.setUTCHours(0, 0, 0, 0);
  return ws;
}

// Build the expected set of buckets for a period window (for zero-fill).
function buildBuckets(
  fromDate: Date,
  days: number,
  weekly: boolean,
): { key: string; label: string; date: Date }[] {
  const buckets: { key: string; label: string; date: Date }[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < days; i++) {
    const d = new Date(fromDate);
    d.setUTCDate(d.getUTCDate() + i);
    const anchor = weekly ? weekStart(d) : d;
    const key    = anchor.toISOString().slice(0, 10);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = days === 7 ? fmtDow(anchor) : fmtDate(anchor);
    buckets.push({ key, label, date: anchor });
  }
  return buckets;
}

// Zero-fill a db result map into an ordered number array matching buckets.
function fillSeries(
  buckets: { key: string }[],
  map:     Map<string, number>,
): number[] {
  return buckets.map(b => map.get(b.key) ?? 0);
}

// node-pg returns a `::date` column as a JS Date pinned to LOCAL midnight (not a
// string). Comparing that to a 'YYYY-MM-DD' string coerces to NaN, and using it
// as a Map key never matches buildBuckets()'s keys. Normalise to 'YYYY-MM-DD'
// from the LOCAL components — toISOString() would shift the date across the UTC
// boundary (a UTC-5 host turns 04-27 into 04-26).
function normalizeBucketKey(bucket: string | Date): string {
  if (typeof bucket === 'string') return bucket.slice(0, 10);
  const d = bucket as Date;
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildTrendsSnapshot(
  tenantId:  number,
  period:    NarrativePeriod,
  platform:  string,
): Promise<TrendsSnapshot> {
  const days           = periodDays(period);
  const weekly         = period === '90day';
  const platformFilter = platform === 'all' ? null : platform;

  // Date windows
  const currentEnd   = utcDayStart(0);   // today (end of current period)
  const currentStart = utcDayStart(days);
  const priorEnd     = utcDayStart(days);
  const priorStart   = utcDayStart(days * 2);

  const currentBuckets = buildBuckets(currentStart, days, weekly);
  const priorBuckets   = buildBuckets(priorStart,   days, weekly);

  const bucketExpr = weekly
    ? `DATE_TRUNC('week', date AT TIME ZONE 'UTC')::date`
    : `date::date`;

  const client = await pool.connect();
  try {

    // ── 1. Account-level series — both periods in one query ──────────────────
    const acctRes = await client.query<{
      bucket:         string;
      reach:          string;
      followers:      string;
      visits:         string;
      comments:       string;
      interactions:   string;   // likes + comments + saves + shares
    }>(
      `SELECT
         ${bucketExpr}                                                       AS bucket,
         SUM(COALESCE(reach, views, 0))                                     AS reach,
         SUM(COALESCE(followers_delta, 0))                                  AS followers,
         SUM(COALESCE(profile_visits, 0))                                   AS visits,
         SUM(COALESCE(comments_count, 0))                                   AS comments,
         -- Prefer the authoritative aggregate engagement column (Facebook's
         -- page_post_engagements); fall back to the like/comment/save/share sum
         -- for platforms that report those instead. Mirrors read-api.ts — the
         -- per-column values are 0 for Facebook, so summing them alone yielded a
         -- 0% engagement rate despite real engagement.
         SUM(
           COALESCE(engagement,
                    COALESCE(likes,0) + COALESCE(comments_count,0) +
                    COALESCE(saves,0) + COALESCE(shares,0))
         )                                                                   AS interactions,
         SUM(COALESCE(reach, views, 0))                                     AS base_reach
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date      >= $2
         AND date      <  $3
         AND ($4::text IS NULL OR platform = $4)
       GROUP BY ${bucketExpr}
       ORDER BY bucket`,
      [tenantId, priorStart, currentEnd, platformFilter],
    );

    // Separate into current / prior maps keyed by ISO date string
    const curMap = { reach: new Map<string,number>(), followers: new Map<string,number>(), visits: new Map<string,number>(), comments: new Map<string,number>(), interactions: new Map<string,number>(), baseReach: new Map<string,number>() };
    const priMap = { reach: new Map<string,number>(), followers: new Map<string,number>(), visits: new Map<string,number>(), comments: new Map<string,number>(), interactions: new Map<string,number>(), baseReach: new Map<string,number>() };

    const currentStartStr = currentStart.toISOString().slice(0, 10);

    for (const row of acctRes.rows) {
      const bucketKey = normalizeBucketKey(row.bucket);
      const isCurrent = bucketKey >= currentStartStr;
      const m = isCurrent ? curMap : priMap;
      m.reach.set(bucketKey,        Number(row.reach));
      m.followers.set(bucketKey,    Number(row.followers));
      m.visits.set(bucketKey,       Number(row.visits));
      m.comments.set(bucketKey,     Number(row.comments));
      m.interactions.set(bucketKey, Number(row.interactions));
      m.baseReach.set(bucketKey,    Number(row.reach));
    }

    // ── 1b. Comments series — from insights_comments (the real per-comment rows) ─
    // NOT insights_account_metrics_daily.comments_count, which Facebook reports as
    // 0 (page-level insights expose no daily comment count). Sourcing the Comments
    // trend from the account column left it empty despite unreplied comments
    // existing — so read the actual comment rows, bucketed by received_at.
    const commentBucketExpr = weekly
      ? `DATE_TRUNC('week', received_at AT TIME ZONE 'UTC')::date`
      : `(received_at AT TIME ZONE 'UTC')::date`;
    const commentsSeriesRes = await client.query<{ bucket: string; comments: string }>(
      `SELECT ${commentBucketExpr} AS bucket, COUNT(*) AS comments
         FROM insights_comments
        WHERE tenant_id    = $1
          AND received_at >= $2
          AND received_at <  $3
          AND ($4::text IS NULL OR platform = $4)
        GROUP BY ${commentBucketExpr}`,
      [tenantId, priorStart, currentEnd, platformFilter],
    );
    const curCommentsMap = new Map<string, number>();
    const priCommentsMap = new Map<string, number>();
    for (const row of commentsSeriesRes.rows) {
      const key = normalizeBucketKey(row.bucket);
      (key >= currentStartStr ? curCommentsMap : priCommentsMap).set(key, Number(row.comments));
    }

    // Build per-bucket engagement rate: interactions / reach * 100
    const curEngMap = new Map<string, number>();
    const priEngMap = new Map<string, number>();

    for (const b of currentBuckets) {
      const int = curMap.interactions.get(b.key) ?? 0;
      const rch = curMap.baseReach.get(b.key) ?? 0;
      curEngMap.set(b.key, rch > 0 ? Math.round((int / rch) * 1000) / 10 : 0);
    }
    for (const b of priorBuckets) {
      const int = priMap.interactions.get(b.key) ?? 0;
      const rch = priMap.baseReach.get(b.key) ?? 0;
      priEngMap.set(b.key, rch > 0 ? Math.round((int / rch) * 1000) / 10 : 0);
    }

    // Aggregate totals for the metric summary cards
    const sumCur = (m: Map<string,number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const sumPri = (m: Map<string,number>) => [...m.values()].reduce((a, b) => a + b, 0);

    const curReach    = sumCur(curMap.reach);
    const priReach    = sumPri(priMap.reach);
    const curFollow   = sumCur(curMap.followers);
    const priFollow   = sumPri(priMap.followers);
    const curVisits   = sumCur(curMap.visits);
    const priVisits   = sumPri(priMap.visits);
    const curComments = sumCur(curCommentsMap);
    const priComments = sumPri(priCommentsMap);

    const curIntTotal = sumCur(curMap.interactions);
    const priIntTotal = sumPri(priMap.interactions);
    const curEngRate  = curReach > 0 ? Math.round((curIntTotal / curReach) * 1000) / 10 : 0;
    const priEngRate  = priReach > 0 ? Math.round((priIntTotal / priReach) * 1000) / 10 : 0;

    const pctDelta = (cur: number, pri: number): number | null => {
      // No meaningful comparison without a real prior baseline — a freshly
      // connected account has ~no data in the prior window. Also suppress the
      // absurd magnitudes a near-zero baseline produces (e.g. 1 → 33 = +3200%),
      // which read as broken; the template then falls back to the absolute value.
      if (pri <= 0) return null;
      const d = ((cur - pri) / pri) * 100;
      if (!Number.isFinite(d) || Math.abs(d) > 999) return null;
      return Math.round(d);
    };

    // Visits available if any profile_visits data exists for this selection
    const visitsAvailable = curVisits > 0 || priVisits > 0;

    // ── 2. Platform breakdown — current period only ──────────────────────────
    const platRes = await client.query<{
      platform:      string;
      reach:         string;
      followers:     string;
      visits:        string;
      comments:      string;
      interactions:  string;
      base_reach:    string;
    }>(
      `SELECT
         platform,
         SUM(COALESCE(reach, views, 0))   AS reach,
         SUM(COALESCE(followers_delta,0)) AS followers,
         SUM(COALESCE(profile_visits,0))  AS visits,
         SUM(COALESCE(comments_count,0))  AS comments,
         SUM(COALESCE(engagement, COALESCE(likes,0)+COALESCE(comments_count,0)+COALESCE(saves,0)+COALESCE(shares,0))) AS interactions,
         SUM(COALESCE(reach, views, 0))   AS base_reach
       FROM insights_account_metrics_daily
       WHERE tenant_id = $1
         AND date      >= $2
         AND date      <  $3
         AND ($4::text IS NULL OR platform = $4)
       GROUP BY platform
       ORDER BY reach DESC`,
      [tenantId, currentStart, currentEnd, platformFilter],
    );

    function toSlices(
      rows: typeof platRes.rows,
      getValue: (r: typeof platRes.rows[0]) => number,
    ): PlatformSlice[] {
      const vals = rows.map(r => ({ platform: r.platform, value: getValue(r) }));
      const total = vals.reduce((s, v) => s + v.value, 0);
      return vals.map(v => ({
        ...v,
        pct: total > 0 ? Math.round((v.value / total) * 1000) / 10 : 0,
      }));
    }

    // Per-platform comment counts from insights_comments (same reason as the
    // comments series: the account column is 0 for Facebook). Powers the
    // "Where comments came from" breakdown.
    const commentsByPlatformRes = await client.query<{ platform: string; comments: string }>(
      `SELECT platform, COUNT(*) AS comments
         FROM insights_comments
        WHERE tenant_id    = $1
          AND received_at >= $2
          AND received_at <  $3
          AND ($4::text IS NULL OR platform = $4)
        GROUP BY platform
        ORDER BY comments DESC`,
      [tenantId, currentStart, currentEnd, platformFilter],
    );
    const commentSlices: PlatformSlice[] = (() => {
      const vals = commentsByPlatformRes.rows.map(r => ({ platform: r.platform, value: Number(r.comments) }));
      const total = vals.reduce((s, v) => s + v.value, 0);
      return vals.map(v => ({ ...v, pct: total > 0 ? Math.round((v.value / total) * 1000) / 10 : 0 }));
    })();

    const breakdown = {
      reach:      toSlices(platRes.rows, r => Number(r.reach)),
      followers:  toSlices(platRes.rows, r => Number(r.followers)),
      visits:     visitsAvailable ? toSlices(platRes.rows, r => Number(r.visits)) : null,
      comments:   commentSlices,
      engagement: toSlices(platRes.rows, r => {
        const int = Number(r.interactions);
        const rch = Number(r.base_reach);
        return rch > 0 ? Math.round((int / rch) * 1000) / 10 : 0;
      }),
    };

    // ── 3. Post count ────────────────────────────────────────────────────────
    const postCountRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM insights_posts
       WHERE tenant_id     = $1
         AND published_at  >= $2
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, currentStart, platformFilter],
    );
    const postCount = Number(postCountRes.rows[0].count);

    // ── 4. Unreplied comments ────────────────────────────────────────────────
    const unrepliedRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM insights_comments
       WHERE tenant_id    = $1
         AND received_at  >= $2
         AND is_replied   = false
         AND ($3::text IS NULL OR platform = $3)`,
      [tenantId, currentStart, platformFilter],
    );
    const unreplied = Number(unrepliedRes.rows[0].count);

    // ── 5. Sentiment distribution ─────────────────────────────────────────────
    const sentRes = await client.query<{ sentiment: string | null; count: string }>(
      `SELECT cc.sentiment, COUNT(*) AS count
       FROM insights_comments c
       JOIN insights_comment_classifications cc ON cc.comment_id = c.id
       WHERE c.tenant_id   = $1
         AND c.received_at >= $2
         AND ($3::text IS NULL OR c.platform = $3)
       GROUP BY cc.sentiment`,
      [tenantId, currentStart, platformFilter],
    );

    let sentTotal = 0;
    let sentPositive = 0;
    for (const r of sentRes.rows) {
      const n = Number(r.count);
      sentTotal += n;
      if (r.sentiment === 'positive') sentPositive += n;
    }
    const sentimentPositivePct = sentTotal > 0
      ? Math.round((sentPositive / sentTotal) * 100)
      : 0;

    // ── 6. Top post title ────────────────────────────────────────────────────
    const topPostRes = await client.query<{ title: string | null }>(
      `SELECT p.title
       FROM insights_posts p
       LEFT JOIN insights_post_metrics_daily m
              ON m.post_id = p.id AND m.tenant_id = p.tenant_id
       WHERE p.tenant_id     = $1
         AND p.published_at  >= $2
         AND ($3::text IS NULL OR p.platform = $3)
       GROUP BY p.id, p.title
       ORDER BY SUM(COALESCE(m.reach, m.views, 0)) DESC
       LIMIT 1`,
      [tenantId, currentStart, platformFilter],
    );
    const topPostTitle = topPostRes.rows[0]?.title ?? null;

    // ── 7. 90-day engagement baseline (for key-movement benchmark) ────────────
    // Fetch when the period is not already 90day (avoid re-fetching the same data).
    let engagementBaseline = curEngRate;
    if (period !== '90day') {
      const baselineStart = utcDayStart(90);
      const blRes = await client.query<{ interactions: string; base_reach: string }>(
        `SELECT
           SUM(COALESCE(engagement, COALESCE(likes,0)+COALESCE(comments_count,0)+COALESCE(saves,0)+COALESCE(shares,0))) AS interactions,
           SUM(COALESCE(reach, views, 0)) AS base_reach
         FROM insights_account_metrics_daily
         WHERE tenant_id = $1
           AND date      >= $2
           AND date      <  $3
           AND ($4::text IS NULL OR platform = $4)`,
        [tenantId, baselineStart, currentEnd, platformFilter],
      );
      const blInt = Number(blRes.rows[0]?.interactions ?? 0);
      const blRch = Number(blRes.rows[0]?.base_reach   ?? 0);
      engagementBaseline = blRch > 0
        ? Math.round((blInt / blRch) * 1000) / 10
        : curEngRate;
    }

    // ── Assemble series ───────────────────────────────────────────────────────
    const labels = currentBuckets.map(b => b.label);

    return {
      reach: {
        value:     curReach,
        valuePrev: priReach,
        delta:     pctDelta(curReach, priReach),
      },
      engagement: {
        value:     curEngRate,
        valuePrev: priEngRate,
        delta:     Math.round((curEngRate - priEngRate) * 10) / 10,
      },
      followers: {
        value:     curFollow,
        valuePrev: priFollow,
        delta:     null,
      },
      comments: {
        value:     curComments,
        valuePrev: priComments,
        delta:     null,
      },
      visits: visitsAvailable ? {
        value:     curVisits,
        valuePrev: priVisits,
        delta:     pctDelta(curVisits, priVisits),
      } : null,

      series: {
        reach: {
          current: fillSeries(currentBuckets, curMap.reach),
          prior:   fillSeries(priorBuckets,   priMap.reach),
          labels,
        },
        engagement: {
          current: fillSeries(currentBuckets, curEngMap),
          prior:   fillSeries(priorBuckets,   priEngMap),
          labels,
        },
        followers: {
          current: fillSeries(currentBuckets, curMap.followers),
          prior:   fillSeries(priorBuckets,   priMap.followers),
          labels,
        },
        comments: {
          current: fillSeries(currentBuckets, curCommentsMap),
          prior:   fillSeries(priorBuckets,   priCommentsMap),
          labels,
        },
        visits: visitsAvailable ? {
          current: fillSeries(currentBuckets, curMap.visits),
          prior:   fillSeries(priorBuckets,   priMap.visits),
          labels,
        } : null,
      },

      platformBreakdown: breakdown,

      postCount,
      unreplied,
      sentimentPositivePct,
      topPostTitle,
      engagementBaseline,
      visitsAvailable,
    };

  } finally {
    client.release();
  }
}
