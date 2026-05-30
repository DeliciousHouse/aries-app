/**
 * P1 — Pure payload builder for the honcho-performance-worker.
 *
 * Maps a #513-E `insights_post_metrics_daily` row + post permalink into the
 * `payloadRecord` shape `recordPerformanceEvent` (backend/memory/write-events.ts)
 * consumes. NO DB, NO Meta, NO side effects — fully unit-testable on master
 * ahead of #513 (the input row shape is the frozen contract in
 * insights-513-contract.ts).
 *
 * Boundary: this epic owns the Honcho write leg only. See
 *   docs/plans/2026-05-30-honcho-performance-insights.md
 */

import type { InsightsPostMetricsDailyRow } from './insights-513-contract';
import { scrubPlatformIdsFromPerformancePayload } from './write-events';

export interface BuildPerformancePayloadInput {
  /** 'facebook' | 'instagram' (lower-cased by the builder). */
  platform: string;
  /**
   * The post's real UTC publish day. Accepts YYYY-MM-DD or YYYYMMDD; normalized
   * to YYYY-MM-DD in `published_at_ymd`. This is NOT UTC-now — it drives Honcho's
   * idempotency window so 24h/72h/7d/30d re-polls of the same metric-day collapse.
   */
  publishDayYmd: string;
  /** Latest #513 metrics snapshot row for the post. */
  metricsRow: InsightsPostMetricsDailyRow;
  /**
   * https permalink / insights URL for the post. MUST be https — mirrors
   * recordPerformanceEvent's own source_url guard. Non-https / missing → null
   * return (worker fail-soft skips).
   */
  sourceUrl: string | null;
  /** ISO timestamp the metrics snapshot was fetched (provenance only). */
  fetchedAt: string;
}

/** The shape `recordPerformanceEvent` consumes as `payloadRecord`. */
export interface PerformancePayloadRecord {
  platform: string;
  published_at_ymd: string;
  metrics: {
    reach: number | null;
    impressions: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    /** #513 column `saved` → payload key `saves`. */
    saves: number | null;
    video_views: number | null;
    source_url: string;
  };
  metrics_fetched_at: string;
  metrics_source_url: string;
}

const YMD_DASHED = /^\d{4}-\d{2}-\d{2}$/;
const YMD_COMPACT = /^\d{8}$/;

/** Normalize YYYYMMDD or YYYY-MM-DD → YYYY-MM-DD; null if neither. */
function normalizePublishDay(input: string): string | null {
  const v = input?.trim();
  if (!v) return null;
  if (YMD_DASHED.test(v)) return v;
  if (YMD_COMPACT.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  return null;
}

function isHttpsUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^https:\/\//i.test(value.trim());
}

/**
 * Build the scrubbed payloadRecord. Returns null (worker skips, fail-soft) when:
 *  - sourceUrl is missing/non-https (recordPerformanceEvent would skip anyway), or
 *  - publishDayYmd is unparseable.
 *
 * The returned record is run through `scrubPlatformIdsFromPerformancePayload`
 * here as belt-and-braces (idempotent with the scrub inside recordPerformanceEvent),
 * so no raw platform_post_id / ig_media_id / bare numeric-id string can leak even
 * if a future caller threads one through.
 */
export function buildPerformancePayloadRecord(
  input: BuildPerformancePayloadInput,
): PerformancePayloadRecord | null {
  if (!isHttpsUrl(input.sourceUrl)) return null;
  const publishedAtYmd = normalizePublishDay(input.publishDayYmd);
  if (!publishedAtYmd) return null;

  const m = input.metricsRow;
  const sourceUrl = input.sourceUrl.trim();

  const record: PerformancePayloadRecord = {
    platform: String(input.platform || 'unknown').toLowerCase(),
    published_at_ymd: publishedAtYmd,
    metrics: {
      reach: m.reach ?? null,
      impressions: m.impressions ?? null,
      likes: m.likes ?? null,
      comments: m.comments ?? null,
      shares: m.shares ?? null,
      saves: m.saved ?? null,
      video_views: m.video_views ?? null,
      source_url: sourceUrl,
    },
    metrics_fetched_at: input.fetchedAt,
    metrics_source_url: sourceUrl,
  };

  // Belt-and-braces scrub. The cast is safe: the scrub only ever removes keys /
  // redacts numeric-id strings; none of this record's keys or values match the
  // strip predicate, so the shape is preserved.
  return scrubPlatformIdsFromPerformancePayload(
    record as unknown as Record<string, unknown>,
  ) as unknown as PerformancePayloadRecord;
}
