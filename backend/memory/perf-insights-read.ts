/**
 * P0 — Read model for the honcho-performance-worker.
 *
 * Selects published posts that are due for a delayed real-metrics Honcho write
 * and resolves them against the LIVE `insights_post_metrics_daily` snapshot.
 *
 * This epic is a PURE READER of the insights tables — it never fetches Meta.
 * The column names below are the ones in `scripts/init-db.js`; the previous
 * version of this file targeted a proposed schema that never shipped
 * (`external_post_id`/`day`/`impressions`/`saved`/`comments`/`video_views`) and
 * would have thrown on first contact with the real DB. See
 * insights-513-contract.ts for the full column map AND for the observation
 * cadence decision this query implements.
 */

import {
  insights513TablesPresent,
  OBSERVATION_HORIZON_DAYS,
  type DuePerformancePost,
  type InsightsPostMetricsDailyRow,
} from './insights-513-contract';

/** Minimal query surface — satisfied by both `pg.Pool` and `pg.PoolClient`. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** Max due posts resolved per tick — caps worker DB pressure (guardrail #1). */
export const DUE_POSTS_LIMIT = 200;

/** `(1),(7),(28)` — the horizon VALUES list, kept in sync with the contract. */
const HORIZON_VALUES_SQL = OBSERVATION_HORIZON_DAYS.map((d) => `(${d})`).join(',');

/**
 * Due-posts query. Joins `posts` (the published-state source of truth — NOT
 * scheduled_posts) to the live insights tables and LEFT JOINs the worker-side
 * `honcho_perf_writes` ledger to exclude already-observed
 * `(job_id, platform, observation_day)` triples.
 *
 * Shape notes:
 *  - join key: `insights_posts.external_post_id = posts.platform_post_id`
 *    (+ tenant) — insights_posts has no job_id.
 *  - metrics FK is `insights_post_metrics_daily.post_id -> insights_posts.id`,
 *    NOT external_post_id, and the day column is `date`, NOT `day`.
 *  - LATERAL latest-snapshot (never SUM): rows are lifetime-cumulative.
 *  - `insights_accounts.disabled_at IS NULL` is the production reader contract
 *    tier-1's performance-context.ts already honours — a reconnected account
 *    leaves a dead row behind that must not resurface as fresh data.
 *  - the horizon LATERAL picks the largest post-publish horizon the latest
 *    snapshot has reached, and `observation_day` (publish_day + horizon) is
 *    what the ledger stores in its `metric_day` column. See the cadence note in
 *    insights-513-contract.ts: this is what stops one post from re-claiming an
 *    idempotency key on all 29 remaining days of its window.
 *
 * $1 tenant_id (INTEGER), $2 LIMIT.
 */
export const DUE_PERFORMANCE_POSTS_SQL = `
  SELECT
    p.tenant_id            AS tenant_id,
    p.job_id               AS job_id,
    LOWER(ip.platform)     AS platform,
    to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS publish_day,
    ip.permalink           AS permalink,
    ip.caption             AS caption,
    ip.media_type          AS media_type,
    m.views                AS views,
    m.reach                AS reach,
    m.likes                AS likes,
    m.comments_count       AS comments_count,
    m.shares               AS shares,
    m.saves                AS saves,
    to_char(m.date, 'YYYY-MM-DD') AS metric_day,
    hz.days                AS horizon_days,
    to_char((p.published_at AT TIME ZONE 'UTC')::date + hz.days, 'YYYY-MM-DD') AS observation_day
  FROM posts p
  JOIN insights_posts ip
    ON ip.external_post_id = p.platform_post_id
   AND ip.tenant_id = p.tenant_id
  JOIN insights_accounts a
    ON a.id = ip.account_id
   AND a.disabled_at IS NULL
  JOIN LATERAL (
    SELECT d.views, d.reach, d.likes, d.comments_count, d.shares, d.saves, d.date
    FROM insights_post_metrics_daily d
    WHERE d.tenant_id = ip.tenant_id
      AND d.post_id = ip.id
    ORDER BY d.date DESC
    LIMIT 1
  ) m ON true
  JOIN LATERAL (
    SELECT h.days
    FROM (VALUES ${HORIZON_VALUES_SQL}) AS h(days)
    WHERE m.date >= (p.published_at AT TIME ZONE 'UTC')::date + h.days
    ORDER BY h.days DESC
    LIMIT 1
  ) hz ON true
  LEFT JOIN honcho_perf_writes w
    ON w.tenant_id = p.tenant_id
   AND w.job_id = p.job_id
   AND w.platform = LOWER(ip.platform)
   AND w.metric_day = (p.published_at AT TIME ZONE 'UTC')::date + hz.days
  WHERE p.tenant_id = $1
    AND p.published_status = 'published'
    AND p.job_id IS NOT NULL
    AND p.platform_post_id IS NOT NULL
    AND p.published_at IS NOT NULL
    AND p.published_at <= NOW() - INTERVAL '24 hours'
    AND p.published_at >= NOW() - INTERVAL '30 days'
    AND w.job_id IS NULL
  ORDER BY p.published_at DESC
  LIMIT $2
`;

interface DuePerformanceRow extends Record<string, unknown> {
  tenant_id: number;
  job_id: string;
  platform: string;
  publish_day: string;
  permalink: string | null;
  caption: string | null;
  media_type: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments_count: number | null;
  shares: number | null;
  saves: number | null;
  metric_day: string;
  horizon_days: number | string;
  observation_day: string;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve due performance posts for ONE tenant. Tenant-scoped + parameterized
 * (cross-tenant isolation by construction), LIMIT-capped, single `client.query`
 * (no pool.connect held across work).
 *
 * Gated by `insights513TablesPresent()` — now default ON, with
 * `ARIES_INSIGHTS_513_TABLES_PRESENT=0` as the kill switch.
 */
export async function selectDuePerformancePosts(
  tenantId: number,
  client: Queryable,
  limit: number = DUE_POSTS_LIMIT,
): Promise<DuePerformancePost[]> {
  if (!insights513TablesPresent()) {
    // Kill switch engaged — no data source, no DB touch.
    return [];
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, DUE_POSTS_LIMIT) : DUE_POSTS_LIMIT;
  const { rows } = await client.query<DuePerformanceRow>(DUE_PERFORMANCE_POSTS_SQL, [tenantId, cap]);
  return rows.map((r): DuePerformancePost => {
    const metrics: InsightsPostMetricsDailyRow = {
      views: toNum(r.views),
      reach: toNum(r.reach),
      likes: toNum(r.likes),
      comments_count: toNum(r.comments_count),
      shares: toNum(r.shares),
      saves: toNum(r.saves),
      date: r.metric_day,
    };
    return {
      tenantId: r.tenant_id,
      jobId: r.job_id,
      platform: String(r.platform || 'unknown').toLowerCase(),
      publishDay: r.publish_day,
      permalink: r.permalink ?? null,
      caption: r.caption ?? null,
      mediaType: r.media_type ?? null,
      horizonDays: toNum(r.horizon_days) ?? 1,
      observationDay: r.observation_day,
      metrics,
    };
  });
}

/**
 * Mark a successful Honcho perf write in the worker-side ledger so subsequent
 * ticks cheaply skip it. ON CONFLICT DO NOTHING — idempotent.
 *
 * `metricDay` here is the OBSERVATION ANCHOR day (publish day + horizon), not
 * the raw snapshot date — see the cadence note in insights-513-contract.ts. The
 * column keeps its name because the ledger table is unchanged (no migration).
 *
 * The worker MUST only call this when the Honcho write actually landed (or was
 * already claimed); see the outcome handling in the P2 worker.
 */
export async function markHonchoPerfWritten(
  tenantId: number,
  jobId: string,
  platform: string,
  metricDay: string,
  client: Queryable,
): Promise<void> {
  await client.query(
    `INSERT INTO honcho_perf_writes (tenant_id, job_id, platform, metric_day)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, job_id, platform, metric_day) DO NOTHING`,
    [tenantId, jobId, platform.toLowerCase(), metricDay],
  );
}

/** Distinct tenant ids that have any candidate published post in the window. */
export async function selectTenantsWithDuePosts(client: Queryable): Promise<number[]> {
  if (!insights513TablesPresent()) {
    // Kill switch engaged — the sidecar must not scan posts every tick.
    return [];
  }
  const { rows } = await client.query<{ tenant_id: number }>(
    `SELECT DISTINCT tenant_id FROM posts
     WHERE published_status = 'published'
       AND job_id IS NOT NULL
       AND platform_post_id IS NOT NULL
       AND published_at IS NOT NULL
       AND published_at <= NOW() - INTERVAL '24 hours'
       AND published_at >= NOW() - INTERVAL '30 days'`,
  );
  return rows.map((r) => Number(r.tenant_id)).filter((n) => Number.isFinite(n));
}
