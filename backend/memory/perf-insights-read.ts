/**
 * P0 — Read model for the honcho-performance-worker.
 *
 * Selects published posts that are due for a delayed real-metrics Honcho write
 * and resolves them against #513-E's `insights_post_metrics_daily` snapshot.
 *
 * This epic is a PURE READER of #513's tables — it never fetches Meta. The
 * `insights_*` tables are owned by #513 (see insights-513-contract.ts). Until
 * #513-A/E land on master those tables do not exist, so `selectDuePerformancePosts`
 * short-circuits to [] behind INSIGHTS_513_TABLES_PRESENT. The SQL below is
 * written and frozen against #513-E's documented column names so post-#513
 * wiring is a one-line gate flip (confirm the join key first).
 *
 * Boundary / contract: docs/plans/2026-05-30-honcho-performance-insights.md
 */

import {
  insights513TablesPresent,
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

/**
 * Due-posts query (#513-GATED). Joins `posts` (the published-state source of
 * truth — NOT scheduled_posts) to #513-E's `insights_post_metrics_daily` and
 * LEFT JOINs the worker-side `honcho_perf_writes` ledger to exclude already-
 * written `(job_id, platform, metric_day)`.
 *
 * Window: published 24h..30d ago, status='published', job_id NOT NULL.
 * Latest metrics row per post via DISTINCT ON (external_post_id) ORDER BY day DESC.
 *
 * #513 JOIN KEY: this uses the fallback join documented in the plan's #513
 * boundary —  insights_posts.external_post_id = posts.platform_post_id
 * AND insights_posts.tenant_id = posts.tenant_id. If #513-E's insights_posts
 * carries job_id directly, swap to that (mechanical). Confirm with #513-E
 * before un-gating.
 *
 * Exported so a post-#513 contract / live-DB test can run it against the real
 * planner without booting the worker.
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
    m.reach                AS reach,
    m.impressions          AS impressions,
    m.likes                AS likes,
    m.comments             AS comments,
    m.shares               AS shares,
    m.saved                AS saved,
    m.video_views          AS video_views,
    to_char(m.day, 'YYYY-MM-DD') AS metric_day
  FROM posts p
  JOIN insights_posts ip
    ON ip.external_post_id = p.platform_post_id
   AND ip.tenant_id = p.tenant_id
  JOIN LATERAL (
    SELECT d.reach, d.impressions, d.likes, d.comments, d.shares,
           d.saved, d.video_views, d.day
    FROM insights_post_metrics_daily d
    WHERE d.external_post_id = ip.external_post_id
      AND d.tenant_id = ip.tenant_id
    ORDER BY d.day DESC
    LIMIT 1
  ) m ON true
  LEFT JOIN honcho_perf_writes w
    ON w.tenant_id = p.tenant_id
   AND w.job_id = p.job_id
   AND w.platform = LOWER(ip.platform)
   AND w.metric_day = m.day
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
  reach: number | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saved: number | null;
  video_views: number | null;
  metric_day: string;
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
 * #513-GATED: returns [] without touching the DB while #513-E's tables are not
 * present (INSIGHTS_513_TABLES_PRESENT === false). Post-#513: flip the gate.
 */
export async function selectDuePerformancePosts(
  tenantId: number,
  client: Queryable,
  limit: number = DUE_POSTS_LIMIT,
): Promise<DuePerformancePost[]> {
  if (!insights513TablesPresent()) {
    // #513 (insights_post_metrics_daily / insights_posts) not on master yet.
    // No data source → no due posts. See insights-513-contract.ts.
    return [];
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, DUE_POSTS_LIMIT) : DUE_POSTS_LIMIT;
  const { rows } = await client.query<DuePerformanceRow>(DUE_PERFORMANCE_POSTS_SQL, [tenantId, cap]);
  return rows.map((r): DuePerformancePost => {
    const metrics: InsightsPostMetricsDailyRow = {
      reach: toNum(r.reach),
      impressions: toNum(r.impressions),
      likes: toNum(r.likes),
      comments: toNum(r.comments),
      shares: toNum(r.shares),
      saved: toNum(r.saved),
      video_views: toNum(r.video_views),
      day: r.metric_day,
    };
    return {
      tenantId: r.tenant_id,
      jobId: r.job_id,
      platform: String(r.platform || 'unknown').toLowerCase(),
      publishDay: r.publish_day,
      permalink: r.permalink ?? null,
      metrics,
    };
  });
}

/**
 * Mark a successful Honcho perf write in the worker-side ledger so subsequent
 * ticks cheaply skip it. ON CONFLICT DO NOTHING — idempotent. `metricDay` is the
 * #513 metric day (the post's publish day), matching the due-query exclusion.
 *
 * The worker MUST only call this when the Honcho write was actually attempted
 * (gate ON); see P2 worker for the gate read.
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
    // No DB touch while the #513 insights tables are absent (matches
    // selectDuePerformancePosts) — the sidecar must not scan posts every tick.
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
