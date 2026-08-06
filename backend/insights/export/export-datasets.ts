/**
 * backend/insights/export/export-datasets.ts
 *
 * S5-3 / AA-112 (gap F2a) — the two exportable datasets.
 *
 * COMMENTS ARE DELIBERATELY NOT EXPORTABLE IN v1. `insights_comments` carries
 * `author_handle` and `body_text` — third-party commenter PII — and a CSV
 * download moves that outside the app boundary onto an operator's laptop, past
 * every access control the app has. That needs an explicit product decision
 * (retention, DSR/erasure obligations, who may download), not a default. The
 * route rejects `dataset=comments` by name rather than falling through to a
 * generic "unknown dataset" so the refusal reads as deliberate.
 *
 * Guardrail #1: every query here is CLAMPED (hard row / day caps), tenant-scoped
 * and parameterized, runs sequentially on one caller-supplied client, and the
 * caller releases that client BEFORE streaming bytes to the browser — a slow
 * download must never pin a pooled connection.
 *
 * S2-1 dependency: per-post metrics are lifetime-CUMULATIVE snapshots, so the
 * export reads each post's LATEST row via LATEST_POST_METRICS_LATERAL. Summing
 * a post's dated rows would inflate every exported number ~N× — the ticket's
 * "so exported numbers are true" clause is exactly this.
 */

import { LATEST_POST_METRICS_LATERAL } from '../latest-post-metrics-sql';

export const EXPORT_DATASETS = ['posts', 'account-metrics'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

/** Datasets refused by name, with the reason surfaced to the caller. */
export const REFUSED_DATASETS: Record<string, string> = {
  comments:
    'Comment export is not available: comments carry third-party commenter details, ' +
    'which need an explicit product decision before leaving the app.',
};

/** Hard ceiling on exported post rows, regardless of what the caller asks for. */
export const MAX_EXPORT_POST_ROWS = 5000;
/** Hard ceiling on the account-metrics lookback. */
export const MAX_EXPORT_DAYS = 365;
export const DEFAULT_EXPORT_DAYS = 90;

export function isExportDataset(value: string | null): value is ExportDataset {
  return value !== null && (EXPORT_DATASETS as readonly string[]).includes(value);
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export interface ExportQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface DatasetResult {
  header: readonly string[];
  rows: unknown[][];
  /** True when the hard cap truncated the result — surfaced to the operator. */
  truncated: boolean;
}

/** $1 tenant, $2 platform-or-null, $3 limit. */
export const EXPORT_POSTS_SQL = `
  SELECT
    p.id                             AS post_id,
    p.platform                       AS platform,
    p.external_post_id               AS external_post_id,
    p.published_at                   AS published_at,
    p.media_type                     AS media_type,
    p.content_type                   AS content_type,
    p.title                          AS title,
    p.caption                        AS caption,
    p.permalink                      AS permalink,
    -- S2-1: LATEST lifetime snapshot per post, never a SUM across dated rows.
    COALESCE(m.reach, 0)             AS reach,
    COALESCE(m.views, 0)             AS views,
    COALESCE(m.likes, 0)             AS likes,
    COALESCE(m.comments_count, 0)    AS comments_count,
    COALESCE(m.shares, 0)            AS shares,
    COALESCE(m.saves, 0)             AS saves,
    m.avg_view_percentage            AS avg_view_percentage
  FROM insights_posts p
  ${LATEST_POST_METRICS_LATERAL}
  WHERE p.tenant_id = $1
    AND ($2::text IS NULL OR p.platform = $2)
  ORDER BY p.published_at DESC, p.id DESC
  LIMIT $3
`;

export const EXPORT_POSTS_HEADER = [
  'post_id',
  'platform',
  'external_post_id',
  'published_at',
  'media_type',
  'content_type',
  'title',
  'caption',
  'permalink',
  'reach',
  'views',
  'likes',
  'comments_count',
  'shares',
  'saves',
  'avg_view_percentage',
] as const;

/** $1 tenant, $2 from-date (tenant-tz calendar key), $3 platform-or-null. */
export const EXPORT_ACCOUNT_METRICS_SQL = `
  SELECT
    date::text                           AS date,
    platform                             AS platform,
    COALESCE(SUM(views), 0)              AS views,
    COALESCE(SUM(reach), 0)              AS reach,
    COALESCE(MAX(followers), 0)          AS followers,
    COALESCE(SUM(followers_delta), 0)    AS followers_delta,
    COALESCE(SUM(profile_visits), 0)     AS profile_visits,
    COALESCE(SUM(likes), 0)              AS likes,
    COALESCE(SUM(comments_count), 0)     AS comments_count,
    COALESCE(SUM(shares), 0)             AS shares,
    COALESCE(SUM(saves), 0)              AS saves,
    COALESCE(SUM(watch_time_minutes), 0) AS watch_time_minutes
  FROM insights_account_metrics_daily
  WHERE tenant_id = $1
    AND date >= $2::date
    AND ($3::text IS NULL OR platform = $3)
  GROUP BY date, platform
  ORDER BY date ASC, platform ASC
`;

export const EXPORT_ACCOUNT_METRICS_HEADER = [
  'date',
  'platform',
  'views',
  'reach',
  'followers',
  'followers_delta',
  'profile_visits',
  'likes',
  'comments_count',
  'shares',
  'saves',
  'watch_time_minutes',
] as const;

export async function loadPostsDataset(
  db: ExportQueryable,
  tenantId: number,
  platform: string | null,
  limit: number,
): Promise<DatasetResult> {
  const cap = clampInt(limit, 1, MAX_EXPORT_POST_ROWS);
  const { rows } = await db.query<Record<string, unknown>>(EXPORT_POSTS_SQL, [
    tenantId,
    platform,
    cap,
  ]);
  return {
    header: EXPORT_POSTS_HEADER,
    rows: rows.map((r) => EXPORT_POSTS_HEADER.map((col) => r[col])),
    truncated: rows.length >= cap,
  };
}

export async function loadAccountMetricsDataset(
  db: ExportQueryable,
  tenantId: number,
  fromDateKey: string,
  platform: string | null,
): Promise<DatasetResult> {
  const { rows } = await db.query<Record<string, unknown>>(EXPORT_ACCOUNT_METRICS_SQL, [
    tenantId,
    fromDateKey,
    platform,
  ]);
  return {
    header: EXPORT_ACCOUNT_METRICS_HEADER,
    rows: rows.map((r) => EXPORT_ACCOUNT_METRICS_HEADER.map((col) => r[col])),
    // Bounded by the clamped day window rather than a row cap.
    truncated: false,
  };
}
