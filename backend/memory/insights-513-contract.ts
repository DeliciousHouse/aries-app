/**
 * #513 INTEGRATION CONTRACT — Meta insights tables owned by issue #513
 * (branch `hammad/analytics-backend`, children A + E). These tables/columns do
 * NOT exist on master yet. This file is the single, documented seam that this
 * epic (honcho-performance-insights) consumes; #513-E satisfies it.
 *
 * DO NOT re-implement #513's Meta fetch/store here. This epic is a pure
 * reader-of-tables / writer-of-memory. See:
 *   docs/plans/2026-05-30-honcho-performance-insights.md  (#513 boundary section)
 *
 * ---------------------------------------------------------------------------
 * What #513-E must provide for this epic to wire up (post-#513, mechanical):
 *
 *   insights_posts
 *     tenant_id        INTEGER  (FK organizations.id) — matches posts.tenant_id
 *     external_post_id TEXT     — equals posts.platform_post_id
 *     platform         TEXT     — 'facebook' | 'instagram'
 *     permalink        TEXT     — https public/insights URL for the post
 *     posted_at        TIMESTAMPTZ
 *     -- join key to Aries marketing job: either insights_posts.job_id directly,
 *     -- or (external_post_id = posts.platform_post_id AND tenant_id = posts.tenant_id)
 *     --   then posts.job_id. Confirm with #513-E before freezing P0's query.
 *
 *   insights_post_metrics_daily   (latest row per post = the snapshot we read)
 *     tenant_id        INTEGER
 *     external_post_id TEXT
 *     platform         TEXT
 *     day              DATE      — the metric day (the post's UTC publish day for dedupe)
 *     reach            BIGINT
 *     impressions      BIGINT
 *     likes            BIGINT
 *     comments         BIGINT
 *     shares           BIGINT
 *     saved            BIGINT     — maps to payload metric key `saves`
 *     video_views      BIGINT
 *
 * Until #513-E lands these tables, `selectDuePerformancePosts` short-circuits
 * (see INSIGHTS_513_TABLES_PRESENT) and returns []. The SQL is written and
 * frozen against the column names above so post-#513 wiring is a one-line flip.
 * ---------------------------------------------------------------------------
 */

/**
 * The metric columns this epic reads from #513-E's `insights_post_metrics_daily`.
 * Numeric metrics are read as numbers; `day` is the metric day (post publish day).
 * `saved` (Meta's column name) maps to the payload key `saves` in P1.
 */
export interface InsightsPostMetricsDailyRow {
  reach: number | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** Meta column name; mapped to payload `saves`. */
  saved: number | null;
  video_views: number | null;
  /** The metric day (YYYY-MM-DD). The post's UTC publish day drives Honcho dedupe. */
  day: string;
}

/**
 * One due published post joined to its latest #513 metrics row. The resolved
 * shape `selectDuePerformancePosts` returns and the worker consumes.
 */
export interface DuePerformancePost {
  /** organizations.id — INTEGER, matches posts.tenant_id. */
  tenantId: number;
  /** Aries marketing job id (posts.job_id) → loadSocialContentJobRuntime. */
  jobId: string;
  /** 'facebook' | 'instagram' (lower-cased). */
  platform: string;
  /** The post's real UTC publish day, YYYY-MM-DD (NOT UTC-now). */
  publishDay: string;
  /**
   * https permalink / insights URL for the post (#513 insights_posts.permalink).
   * Required by recordPerformanceEvent's https source_url guard. If #513 cannot
   * supply an https permalink, the worker fail-soft-skips this post.
   */
  permalink: string | null;
  /** Latest #513 metrics snapshot for this post. */
  metrics: InsightsPostMetricsDailyRow;
}

/**
 * #513 GATE. Returns `true` once #513-A schema + #513-E adapter have merged to
 * master and `insights_post_metrics_daily` is populated. While `false`,
 * `selectDuePerformancePosts` returns [] without touching the DB, so this epic
 * compiles, tests (fixture-backed), and ships dormant on master ahead of #513.
 *
 * Read at CALL TIME (a function, not a load-time const) so the docker sidecar's
 * process env applies and tests / dynamic toggling work. The env override
 * (`ARIES_INSIGHTS_513_TABLES_PRESENT=1`) lets the post-#513 contract/live-DB
 * tests exercise the real query without a code change.
 *
 * POST-#513 WIRING (mechanical): default this to `true` (or delete the gate)
 * and confirm DUE_PERFORMANCE_POSTS_SQL's join key against #513-E's actual
 * insights_posts shape.
 */
export function insights513TablesPresent(
  env: Partial<Record<string, string | undefined>> = process.env,
): boolean {
  return env.ARIES_INSIGHTS_513_TABLES_PRESENT === '1';
}
