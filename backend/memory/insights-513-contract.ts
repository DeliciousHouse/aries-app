/**
 * INSIGHTS SCHEMA CONTRACT — the `insights_*` tables this epic
 * (honcho-performance-insights) reads. This file is the single documented seam.
 *
 * HISTORY (S4-4 / roadmap gap B2): this contract was originally frozen as "#513"
 * against a *proposed* schema, before the tables existed. They landed with
 * different column names, so the frozen SQL referenced columns that were never
 * created and flipping the gate would have errored every tick. The shapes below
 * now mirror the LANDED schema in `scripts/init-db.js`.
 *
 * DO NOT re-implement the Meta fetch/store here. This epic is a pure
 * reader-of-tables / writer-of-memory. See:
 *   docs/plans/2026-05-30-honcho-performance-insights.md
 *
 * ---------------------------------------------------------------------------
 * LANDED schema (scripts/init-db.js), the columns this epic reads:
 *
 *   insights_posts
 *     id               BIGSERIAL PK — the key metrics rows join on
 *     tenant_id        INTEGER  (FK organizations.id) — matches posts.tenant_id
 *     external_post_id TEXT     — equals posts.platform_post_id
 *     platform         TEXT     — 'facebook' | 'instagram'
 *     media_type       TEXT     — 'video'|'short'|'image'|'carousel'|'reel'|'story'|'text'|'live'
 *     permalink        TEXT     — https public/insights URL for the post
 *     published_at     TIMESTAMPTZ
 *     -- join to the Aries marketing job goes through `posts`:
 *     --   (external_post_id = posts.platform_post_id AND tenant_id = posts.tenant_id
 *     --    AND normalized platform match) then posts.job_id.
 *     -- NOT via the newer `aries_post_id` column: its coverage is partial by
 *     -- design (that is what S4-1's attribution coverage gate measures), so
 *     -- joining on it would silently drop unstamped history.
 *
 *   insights_post_metrics_daily   (latest row per post = the snapshot we read)
 *     tenant_id      INTEGER
 *     post_id        BIGINT  — FK insights_posts(id). There is no
 *                              external_post_id column on this table.
 *     platform       TEXT
 *     date           DATE    — the SYNC date, NOT the post's publish day
 *     reach          BIGINT
 *     views          BIGINT
 *     likes          INT
 *     comments_count INT
 *     shares         INT
 *     saves          INT
 *
 * Rows are lifetime-CUMULATIVE snapshots: the LATEST row per post is that post's
 * true running total, so readers take `ORDER BY date DESC LIMIT 1` and never SUM
 * across a post's dated rows (~N× inflation). See
 * backend/insights/latest-post-metrics-sql.ts for the shared read-model idiom.
 *
 * Payload fields with NO landed counterpart (S4-4 decision, recorded here so a
 * future reader does not "restore" them):
 *   impressions  — no landed column. The payload key is emitted as null.
 *   video_views  — mapped from `views`, but ONLY for video media types. `views`
 *                  is populated for every media type, so writing it
 *                  unconditionally would report an image post's view count as
 *                  video views.
 * For both, null means "not available" and never 0 (the silent-zero trap S4-2
 * documented for the ingest side).
 * ---------------------------------------------------------------------------
 */

/**
 * The metric columns this epic reads from `insights_post_metrics_daily`, named
 * after the LANDED columns. Numeric metrics are read as numbers.
 * `saves` maps to the payload key `saves` in P1; `comments_count` to `comments`.
 */
export interface InsightsPostMetricsDailyRow {
  reach: number | null;
  likes: number | null;
  /** Landed column name (the proposed contract called this `comments`). */
  comments_count: number | null;
  shares: number | null;
  /** Landed column name (the proposed contract called this `saved`). */
  saves: number | null;
  /**
   * Landed `views`, but resolved to NULL for non-video media types — `views` is
   * populated for every media type, so an image post's views must never be
   * reported as video views. NULL = not available, never 0.
   */
  video_views: number | null;
  /**
   * The snapshot's SYNC date (YYYY-MM-DD) — provenance only. This is NOT the
   * Honcho dedupe/ledger day: that is the post's UTC PUBLISH day
   * (`DuePerformancePost.publishDay`), which is what `recordPerformanceEvent`
   * keys its idempotency claim on. Keying the ledger on this date instead would
   * mint a fresh ledger row on every sync day and re-drive an already-written
   * post forever.
   */
  snapshot_date: string;
}

/**
 * One due published post joined to its latest metrics snapshot. The resolved
 * shape `selectDuePerformancePosts` returns and the worker consumes.
 */
export interface DuePerformancePost {
  /** organizations.id — INTEGER, matches posts.tenant_id. */
  tenantId: number;
  /** Aries marketing job id (posts.job_id) → loadSocialContentJobRuntime. */
  jobId: string;
  /** 'facebook' | 'instagram' (lower-cased). */
  platform: string;
  /**
   * The post's real UTC publish day, YYYY-MM-DD (NOT UTC-now, NOT the snapshot
   * sync date). Drives BOTH the Honcho idempotency key and the
   * `honcho_perf_writes` ledger day, so the two can never disagree.
   */
  publishDay: string;
  /**
   * https permalink / insights URL for the post (insights_posts.permalink).
   * Required by recordPerformanceEvent's https source_url guard. Without an
   * https permalink the worker fail-soft-skips this post.
   */
  permalink: string | null;
  /** Latest metrics snapshot for this post. */
  metrics: InsightsPostMetricsDailyRow;
}

/**
 * ROLLOUT GATE. Returns `true` once `insights_post_metrics_daily` is populated
 * for the deployment. While `false`, `selectDuePerformancePosts` returns []
 * without touching the DB, so the sidecar boots and ticks as a harmless no-op.
 *
 * Read at CALL TIME (a function, not a load-time const) so the docker sidecar's
 * process env applies and tests / dynamic toggling work.
 *
 * As of S4-4 the SQL behind this gate matches the landed schema, so flipping
 * `ARIES_INSIGHTS_513_TABLES_PRESENT=1` is now an ops action (flag-flip
 * checklist row 2 in docs/plans/2026-07-07-analytics-page-roadmap.md) rather
 * than a code change. The default stays OFF so the flip — and its rollback —
 * is an env change on the host, not a redeploy.
 */
export function insights513TablesPresent(
  env: Partial<Record<string, string | undefined>> = process.env,
): boolean {
  return env.ARIES_INSIGHTS_513_TABLES_PRESENT === '1';
}
