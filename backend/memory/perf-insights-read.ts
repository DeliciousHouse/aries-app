/**
 * P0 — Read model for the honcho-performance-worker.
 *
 * Selects published posts that are due for a delayed real-metrics Honcho write
 * and resolves them against the `insights_post_metrics_daily` snapshot.
 *
 * This epic is a PURE READER of the insights tables — it never fetches Meta (see
 * insights-513-contract.ts for the landed column map). While the rollout gate
 * INSIGHTS_513_TABLES_PRESENT is off, `selectDuePerformancePosts` short-circuits
 * to [] without touching the DB.
 *
 * S4-4 repaired the SQL below, which had been frozen against a proposed schema
 * that mismatched the landed one on six axes.
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
 * Media types whose `views` column is a VIDEO view count. `insights_post_metrics_daily.views`
 * is populated for every media type, so an image/carousel post's views must not
 * be reported as `video_views` (S4-4 decision — see insights-513-contract.ts).
 */
export const VIDEO_MEDIA_TYPES = ['video', 'reel', 'short'] as const;

/**
 * Normalize a platform column for comparison, collapsing the legacy `meta` alias
 * onto `facebook`. `posts.platform` really does carry both spellings; the shipped
 * insights attribution join uses this same idiom
 * (backend/insights/sync/dispatcher.ts), so a plain LOWER() compare here would
 * silently drop Facebook rows.
 */
function normalizedPlatform(column: string): string {
  return `CASE WHEN lower(${column}) = 'meta' THEN 'facebook' ELSE lower(${column}) END`;
}

/**
 * Due-posts query (GATED). Joins `posts` (the published-state source of truth —
 * NOT scheduled_posts) to `insights_posts` → `insights_post_metrics_daily`, and
 * LEFT JOINs the worker-side `honcho_perf_writes` ledger to exclude already-
 * written `(job_id, platform, metric_day)`.
 *
 * Window: published 24h..30d ago, status='published', job_id NOT NULL.
 *
 * LATEST SNAPSHOT: metrics rows are lifetime-CUMULATIVE, so the newest row per
 * post is that post's true total — resolved with `ORDER BY d.date DESC LIMIT 1`,
 * never SUM across a post's dated rows (~N× inflation; S2-1/AA-92). This mirrors
 * `LATEST_POST_METRICS_LATERAL` (backend/insights/latest-post-metrics-sql.ts);
 * it is spelled out locally because that constant hardcodes the outer alias `p`
 * (taken here by `posts`) and does not select `date`.
 *
 * LEDGER DAY: `metric_day` is the post's UTC PUBLISH day, not the snapshot's
 * sync date — it must match the day `recordPerformanceEvent` builds its
 * idempotency key from. Keying on the sync date would mint a new ledger row
 * every sync day, so an already-written post would be re-driven on every tick
 * only for the Honcho-side claim to reject it.
 *
 * Exported so a live-schema (requires-infra) test can run it against the real
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
    m.likes                AS likes,
    m.comments_count       AS comments_count,
    m.shares               AS shares,
    m.saves                AS saves,
    CASE
      WHEN lower(ip.media_type) IN (${VIDEO_MEDIA_TYPES.map((t) => `'${t}'`).join(', ')})
      THEN m.views
    END                    AS video_views,
    to_char(m.date, 'YYYY-MM-DD') AS snapshot_date
  FROM posts p
  JOIN insights_posts ip
    ON ip.external_post_id = p.platform_post_id
   AND ip.tenant_id = p.tenant_id
   AND ${normalizedPlatform('ip.platform')} = ${normalizedPlatform('p.platform')}
  JOIN LATERAL (
    SELECT d.reach, d.views, d.likes, d.comments_count, d.shares, d.saves, d.date
    FROM insights_post_metrics_daily d
    WHERE d.post_id = ip.id
      AND d.tenant_id = ip.tenant_id
    ORDER BY d.date DESC
    LIMIT 1
  ) m ON true
  LEFT JOIN honcho_perf_writes w
    ON w.tenant_id = p.tenant_id
   AND w.job_id = p.job_id
   AND w.platform = LOWER(ip.platform)
   AND w.metric_day = (p.published_at AT TIME ZONE 'UTC')::date
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
  likes: number | null;
  comments_count: number | null;
  shares: number | null;
  saves: number | null;
  video_views: number | null;
  snapshot_date: string;
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
 * GATED: returns [] without touching the DB while the insights tables are not
 * populated for this deployment (INSIGHTS_513_TABLES_PRESENT === false).
 */
export async function selectDuePerformancePosts(
  tenantId: number,
  client: Queryable,
  limit: number = DUE_POSTS_LIMIT,
): Promise<DuePerformancePost[]> {
  if (!insights513TablesPresent()) {
    // Rollout gate off — insights_post_metrics_daily is not populated for this
    // deployment. No data source → no due posts. See insights-513-contract.ts.
    return [];
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, DUE_POSTS_LIMIT) : DUE_POSTS_LIMIT;
  const { rows } = await client.query<DuePerformanceRow>(DUE_PERFORMANCE_POSTS_SQL, [tenantId, cap]);
  return rows.map((r): DuePerformancePost => {
    const metrics: InsightsPostMetricsDailyRow = {
      reach: toNum(r.reach),
      likes: toNum(r.likes),
      comments_count: toNum(r.comments_count),
      shares: toNum(r.shares),
      saves: toNum(r.saves),
      video_views: toNum(r.video_views),
      snapshot_date: r.snapshot_date,
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
 * ticks cheaply skip it. ON CONFLICT DO NOTHING — idempotent. `metricDay` MUST be
 * the post's UTC publish day, matching both the due-query exclusion join and the
 * day `recordPerformanceEvent` keys its idempotency claim on — NOT the metrics
 * snapshot's sync date, which advances on every insights tick.
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
    // No DB touch while the rollout gate is off (matches
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
