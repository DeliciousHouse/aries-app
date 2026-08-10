/**
 * LIVE INSIGHTS CONTRACT — the `insights_*` tables this epic reads.
 *
 * HISTORY: this file used to describe #513's PROPOSED schema (`external_post_id`
 * / `day` / `impressions` / `saved` / `comments` / `video_views` on
 * `insights_post_metrics_daily`). #513 shipped with a DIFFERENT shape, and the
 * gate below stayed off, so the drift was never caught by anything: the SQL
 * referenced columns that do not exist and would have thrown on first contact
 * with the real DB. The shapes here now mirror `scripts/init-db.js` verbatim.
 *
 * This epic remains a PURE READER of those tables — it never fetches Meta.
 *
 * ---------------------------------------------------------------------------
 * REAL SCHEMA (scripts/init-db.js — insights_posts ~1289, metrics ~1348):
 *
 *   insights_accounts
 *     id           BIGSERIAL PK
 *     tenant_id    INTEGER
 *     platform     TEXT
 *     disabled_at  TIMESTAMPTZ   -- production reader contract: IS NULL only
 *
 *   insights_posts
 *     id                BIGSERIAL PK      -- the metrics FK target
 *     tenant_id         INTEGER
 *     account_id        BIGINT -> insights_accounts(id)
 *     platform          TEXT
 *     external_post_id  TEXT              -- equals posts.platform_post_id
 *     published_at      TIMESTAMPTZ
 *     media_type        TEXT              -- video|short|image|carousel|reel|story|text|live
 *     caption           TEXT
 *     permalink         TEXT
 *
 *   insights_post_metrics_daily            (PK tenant_id, post_id, date)
 *     tenant_id       INTEGER
 *     post_id         BIGINT -> insights_posts(id)   -- NOT external_post_id
 *     platform        TEXT
 *     date            DATE                            -- NOT `day`
 *     views, reach    BIGINT
 *     likes, comments_count, shares, saves  INT       -- NOT impressions/saved/comments/video_views
 *
 * Rows are LIFETIME-CUMULATIVE snapshots, so the reader takes the LATEST row
 * per post (LATERAL … ORDER BY date DESC LIMIT 1) and never SUMs them.
 * ---------------------------------------------------------------------------
 *
 * OBSERVATION CADENCE (deliberate decision — reviewer required change #2):
 *
 * The naive design — ledger on the latest `metric_day`, idempotency key on the
 * publish day — is self-contradictory: the ledger LEFT JOIN makes a post due
 * again every time a new daily snapshot lands, while the single publish-day
 * idempotency key means every one of those re-drives is a no-op claim. That is
 * ~29 days of pure ledger churn per post for exactly one observation.
 *
 * We take the LONGITUDINAL option: a post is observed at fixed horizons after
 * publish — 24h, 7d and 28d (`OBSERVATION_HORIZON_DAYS`). Rationale:
 *   - the compounding profile wants trajectory ("this reel kept earning saves
 *     for a month") not a single 24h snapshot;
 *   - the metrics visible when the gate is flipped on are a very different
 *     signal from the metrics at 24h, and collapsing them loses that;
 *   - it bounds writes at 3 per (post, platform) instead of 1 or 30.
 *
 * MECHANICS, so the ledger needs no migration: `honcho_perf_writes.metric_day`
 * stores the horizon ANCHOR date (`publish_day + horizon_days`), not the raw
 * snapshot date. It is deterministic, distinct per horizon, and slots into the
 * existing PK (tenant_id, job_id, platform, metric_day) unchanged. The Honcho
 * idempotency key likewise carries the anchor, so a re-drive of the same
 * horizon is a no-op while a NEW horizon is a fresh observation.
 *
 * A post first seen after its 28d horizon simply emits the 28d observation
 * once — a late gate flip does NOT backfill 3 observations per post.
 */

/**
 * Post-publish horizons at which a post is observed, in days. A due row is
 * assigned the LARGEST horizon its latest snapshot has reached; earlier
 * horizons already in the ledger are skipped by the due query.
 */
export const OBSERVATION_HORIZON_DAYS = [1, 7, 28] as const;

export type ObservationHorizonDays = (typeof OBSERVATION_HORIZON_DAYS)[number];

/** Human label for a horizon, used in the observation prose. */
export function observationHorizonLabel(days: number): string {
  if (days <= 1) return '24h';
  return `${days}d`;
}

/**
 * The metric columns this epic reads from the LIVE `insights_post_metrics_daily`.
 * Numeric metrics are read as numbers; `date` is the snapshot day.
 */
export interface InsightsPostMetricsDailyRow {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments_count: number | null;
  shares: number | null;
  saves: number | null;
  /** The snapshot day (YYYY-MM-DD) — `insights_post_metrics_daily.date`. */
  date: string;
}

/**
 * One due published post joined to its latest metrics row. The resolved shape
 * `selectDuePerformancePosts` returns and the worker consumes.
 */
export interface DuePerformancePost {
  /** organizations.id — INTEGER, matches posts.tenant_id. */
  tenantId: number;
  /** Aries marketing job id (posts.job_id) → loadSocialContentJobRuntime. */
  jobId: string;
  /** Lower-cased platform. */
  platform: string;
  /** The post's real UTC publish day, YYYY-MM-DD (NOT UTC-now). */
  publishDay: string;
  /**
   * https permalink / insights URL for the post (`insights_posts.permalink`).
   * Required by the payload builder's https source_url guard; a post without
   * one is fail-soft skipped by the worker.
   */
  permalink: string | null;
  /** `insights_posts.caption` — sanitized before it reaches a prompt/memory. */
  caption: string | null;
  /** `insights_posts.media_type` — reel/image/carousel/… */
  mediaType: string | null;
  /** Which post-publish horizon this observation covers (1 | 7 | 28 days). */
  horizonDays: number;
  /**
   * Horizon ANCHOR day (publish_day + horizonDays), YYYY-MM-DD. This is the
   * value written to `honcho_perf_writes.metric_day` and folded into the Honcho
   * idempotency key — see the cadence note above.
   */
  observationDay: string;
  /** Latest metrics snapshot for this post. */
  metrics: InsightsPostMetricsDailyRow;
}

/**
 * INSIGHTS TABLE GATE. The `insights_*` tables ship in `scripts/init-db.js` on
 * every deploy and are populated by the live insights sync, so this now DEFAULTS
 * TO TRUE — the historical `=1`-to-enable semantics were the reason the drifted
 * SQL above was never exercised.
 *
 * `ARIES_INSIGHTS_513_TABLES_PRESENT=0` is now the KILL SWITCH (the read model
 * does no DB work at all); `1` still forces on. Any other value, including
 * unset, means on.
 *
 * Read at CALL TIME (a function, not a load-time const) so the docker sidecar's
 * process env applies and tests can toggle it.
 *
 * Ship-dark is preserved by the Honcho gates, not by this one: the whole write
 * leg stays inert unless HONCHO_ENABLED && HONCHO_WRITE_PUBLISH_ENABLED.
 */
export function insights513TablesPresent(
  env: Partial<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env.ARIES_INSIGHTS_513_TABLES_PRESENT?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return true;
}
