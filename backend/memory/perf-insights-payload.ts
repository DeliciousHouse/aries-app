/**
 * P1 — Pure payload builder for the honcho-performance-worker.
 *
 * Maps a live `insights_post_metrics_daily` row + post permalink/caption into
 * the `payloadRecord` shape `recordPerformanceEvent` (backend/memory/write-events.ts)
 * consumes. NO DB, NO Meta, NO side effects — fully unit-testable.
 *
 * Metric keys mirror the REAL columns (views/reach/likes/comments_count/
 * shares/saves). The old `impressions` and `video_views` keys are gone: those
 * columns never existed on the live table, so anything reading them was reading
 * `undefined` dressed up as data.
 */

import { sanitizeCaptionForPrompt } from '@/backend/marketing/performance-context';

import type { InsightsPostMetricsDailyRow } from './insights-513-contract';
import { scrubPlatformIdsFromPerformancePayload } from './write-events';

/** Caption excerpts in memory are short on purpose — a hook, not the post. */
export const OBSERVATION_CAPTION_CHARS = 160;

export interface BuildPerformancePayloadInput {
  /** Platform slug (lower-cased by the builder). */
  platform: string;
  /**
   * The post's real UTC publish day. Accepts YYYY-MM-DD or YYYYMMDD; normalized
   * to YYYY-MM-DD in `published_at_ymd`. This is NOT UTC-now.
   */
  publishDayYmd: string;
  /** Latest metrics snapshot row for the post. */
  metricsRow: InsightsPostMetricsDailyRow;
  /**
   * https permalink / insights URL for the post. MUST be https — mirrors
   * recordPerformanceEvent's own source_url guard. Non-https / missing → null
   * return (worker fail-soft skips).
   */
  sourceUrl: string | null;
  /** Raw tenant-authored caption; sanitized + truncated by the builder. */
  caption?: string | null;
  /** `insights_posts.media_type` (reel/image/carousel/…). */
  mediaType?: string | null;
  /** ISO timestamp the metrics snapshot was fetched (provenance only). */
  fetchedAt: string;
}

/** The shape `recordPerformanceEvent` consumes as `payloadRecord`. */
export interface PerformancePayloadRecord {
  platform: string;
  published_at_ymd: string;
  media_type: string | null;
  /** Sanitized, ≤160-char excerpt. Empty string when there is no caption. */
  caption_excerpt: string;
  metrics: {
    views: number | null;
    reach: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    saves: number | null;
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

/** Media type is a platform enum; keep it to a short safe slug regardless. */
function normalizeMediaType(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return v ? v.slice(0, 32) : null;
}

/**
 * Build the scrubbed payloadRecord. Returns null (worker skips, fail-soft) when:
 *  - sourceUrl is missing/non-https (recordPerformanceEvent would skip anyway), or
 *  - publishDayYmd is unparseable.
 *
 * The returned record is run through `scrubPlatformIdsFromPerformancePayload`
 * here as belt-and-braces (idempotent with the scrub inside recordPerformanceEvent),
 * so no raw platform_post_id / ig_media_id / bare numeric-id string can leak even
 * if a future caller threads one through. The caption goes through the SAME
 * sanitizer the prompt-side performance block uses (token redaction, control
 * chars, code fences, whitespace collapse, truncation).
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
    media_type: normalizeMediaType(input.mediaType),
    caption_excerpt: sanitizeCaptionForPrompt(input.caption, OBSERVATION_CAPTION_CHARS),
    metrics: {
      views: m.views ?? null,
      reach: m.reach ?? null,
      likes: m.likes ?? null,
      comments: m.comments_count ?? null,
      shares: m.shares ?? null,
      saves: m.saves ?? null,
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
