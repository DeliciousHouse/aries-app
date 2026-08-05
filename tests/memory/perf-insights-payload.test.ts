import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPerformancePayloadRecord,
} from '../../backend/memory/perf-insights-payload';
import type { InsightsPostMetricsDailyRow } from '../../backend/memory/insights-513-contract';

// P1 — pure payload builder. No DB needed: the input row is the landed column
// map from insights-513-contract.ts.

const METRICS: InsightsPostMetricsDailyRow = {
  reach: 1200,
  likes: 300,
  comments_count: 12,
  shares: 5,
  saves: 9,
  video_views: 0,
  snapshot_date: '2026-05-28',
};

test('maps landed columns to payload metric keys (comments_count -> comments)', () => {
  const out = buildPerformancePayloadRecord({
    platform: 'Instagram',
    publishDayYmd: '2026-05-25',
    metricsRow: METRICS,
    sourceUrl: 'https://www.instagram.com/p/ABC123/',
    fetchedAt: '2026-05-27T00:00:00.000Z',
  });
  assert.ok(out);
  assert.equal(out.platform, 'instagram'); // lower-cased
  assert.equal(out.published_at_ymd, '2026-05-25');
  assert.equal(out.metrics.reach, 1200);
  assert.equal(out.metrics.saves, 9);
  assert.equal(out.metrics.comments, 12);
  assert.equal(out.metrics.video_views, 0);
  assert.equal(out.metrics.source_url, 'https://www.instagram.com/p/ABC123/');
  assert.equal(out.metrics_source_url, 'https://www.instagram.com/p/ABC123/');
  // Raw DB column names never leak into the Honcho payload.
  assert.equal((out.metrics as Record<string, unknown>).saved, undefined);
  assert.equal((out.metrics as Record<string, unknown>).comments_count, undefined);
  assert.equal((out.metrics as Record<string, unknown>).snapshot_date, undefined);
});

test('impressions has no landed column: key is present and always null', () => {
  // S4-4 decision — the payload SHAPE stays stable for Honcho, but the value is
  // null ("not available"), never 0 and never sourced from another column.
  const out = buildPerformancePayloadRecord({
    platform: 'instagram',
    publishDayYmd: '2026-05-25',
    metricsRow: METRICS,
    sourceUrl: 'https://www.instagram.com/p/ABC123/',
    fetchedAt: '2026-05-27T00:00:00.000Z',
  });
  assert.ok(out);
  assert.ok('impressions' in out.metrics, 'payload shape must keep the key');
  assert.equal(out.metrics.impressions, null);

  // Even if a caller smuggles an `impressions` value in, it is not read.
  const smuggled = { ...METRICS, impressions: 9999 } as unknown as InsightsPostMetricsDailyRow;
  const out2 = buildPerformancePayloadRecord({
    platform: 'instagram',
    publishDayYmd: '2026-05-25',
    metricsRow: smuggled,
    sourceUrl: 'https://www.instagram.com/p/ABC123/',
    fetchedAt: '2026-05-27T00:00:00.000Z',
  });
  assert.ok(out2);
  assert.equal(out2.metrics.impressions, null);
});

test('null metrics stay null (never coerced to 0)', () => {
  // The silent-zero trap: an image post has no video_views, and "not available"
  // must not read as "zero views".
  const out = buildPerformancePayloadRecord({
    platform: 'instagram',
    publishDayYmd: '2026-05-25',
    metricsRow: { ...METRICS, video_views: null, saves: null },
    sourceUrl: 'https://www.instagram.com/p/ABC123/',
    fetchedAt: '2026-05-27T00:00:00.000Z',
  });
  assert.ok(out);
  assert.equal(out.metrics.video_views, null);
  assert.equal(out.metrics.saves, null);
});

test('published_at_ymd is the POST publish day, not UTC-now', () => {
  const out = buildPerformancePayloadRecord({
    platform: 'facebook',
    publishDayYmd: '2026-05-25',
    metricsRow: METRICS,
    sourceUrl: 'https://www.facebook.com/12/posts/34',
    fetchedAt: '2026-05-29T10:00:00.000Z',
  });
  assert.ok(out);
  // Even though fetchedAt is the 29th, the publish day is the 25th.
  assert.equal(out.published_at_ymd, '2026-05-25');
});

test('accepts compact YYYYMMDD publish day and normalizes to dashed', () => {
  const out = buildPerformancePayloadRecord({
    platform: 'facebook',
    publishDayYmd: '20260525',
    metricsRow: METRICS,
    sourceUrl: 'https://www.facebook.com/12/posts/34',
    fetchedAt: '2026-05-29T10:00:00.000Z',
  });
  assert.ok(out);
  assert.equal(out.published_at_ymd, '2026-05-25');
});

test('returns null when source url is missing or non-https', () => {
  assert.equal(
    buildPerformancePayloadRecord({
      platform: 'facebook',
      publishDayYmd: '2026-05-25',
      metricsRow: METRICS,
      sourceUrl: null,
      fetchedAt: '2026-05-29T10:00:00.000Z',
    }),
    null,
  );
  assert.equal(
    buildPerformancePayloadRecord({
      platform: 'facebook',
      publishDayYmd: '2026-05-25',
      metricsRow: METRICS,
      sourceUrl: 'http://insecure.example.com/p/1',
      fetchedAt: '2026-05-29T10:00:00.000Z',
    }),
    null,
  );
});

test('returns null when publish day is unparseable', () => {
  assert.equal(
    buildPerformancePayloadRecord({
      platform: 'facebook',
      publishDayYmd: 'not-a-date',
      metricsRow: METRICS,
      sourceUrl: 'https://www.facebook.com/12/posts/34',
      fetchedAt: '2026-05-29T10:00:00.000Z',
    }),
    null,
  );
});

test('belt-and-braces scrub: no raw platform_post_id / numeric-id strings leak', () => {
  // Even if a future caller threads a stray id through the metrics row, the
  // builder runs scrubPlatformIdsFromPerformancePayload and it must be gone.
  const dirty = {
    ...METRICS,
    instagram_media_id: '17900000000000000',
  } as unknown as InsightsPostMetricsDailyRow;
  const out = buildPerformancePayloadRecord({
    platform: 'instagram',
    publishDayYmd: '2026-05-25',
    metricsRow: dirty,
    sourceUrl: 'https://www.instagram.com/p/ABC123/',
    fetchedAt: '2026-05-27T00:00:00.000Z',
  });
  assert.ok(out);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('instagram_media_id'), 'platform id key must be stripped');
  assert.ok(!json.includes('17900000000000000'), 'bare numeric id must be redacted');
});
