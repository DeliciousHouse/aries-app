import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPerformancePayloadRecord } from '../../backend/memory/perf-insights-payload';
import type { InsightsPostMetricsDailyRow } from '../../backend/memory/insights-513-contract';

// P1 — pure payload builder. No DB, no live tables: the input row is the
// contract shape from insights-513-contract.ts (now the REAL column names).

const METRICS: InsightsPostMetricsDailyRow = {
  views: 3400,
  reach: 1200,
  likes: 300,
  comments_count: 12,
  shares: 5,
  saves: 9,
  date: '2026-05-26',
};

test('maps the REAL metric columns (comments_count -> comments, saves -> saves)', () => {
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
  assert.equal(out.metrics.views, 3400);
  assert.equal(out.metrics.comments, 12);
  assert.equal(out.metrics.saves, 9);
  assert.equal(out.metrics.source_url, 'https://www.instagram.com/p/ABC123/');
  assert.equal(out.metrics_source_url, 'https://www.instagram.com/p/ABC123/');
  // The columns that never existed on the live table must not reappear.
  const metrics = out.metrics as unknown as Record<string, unknown>;
  assert.equal(metrics.impressions, undefined);
  assert.equal(metrics.video_views, undefined);
  assert.equal(metrics.saved, undefined);
  assert.equal(metrics.comments_count, undefined);
});

test('carries a sanitized caption excerpt and media type', () => {
  const out = buildPerformancePayloadRecord({
    platform: 'instagram',
    publishDayYmd: '2026-05-25',
    metricsRow: METRICS,
    sourceUrl: 'https://www.instagram.com/p/ABC123/',
    caption: '  three ways\nto break in\tnew leather  ```rm -rf```  ',
    mediaType: 'REEL',
    fetchedAt: '2026-05-27T00:00:00.000Z',
  });
  assert.ok(out);
  assert.equal(out.media_type, 'reel');
  // Newlines/tabs collapsed, code fences stripped — a caption can never inject
  // its own line or a fenced block into a prompt or a memory record.
  assert.equal(out.caption_excerpt, 'three ways to break in new leather rm -rf');
});

test('caption excerpt is truncated to 160 chars', () => {
  const out = buildPerformancePayloadRecord({
    platform: 'instagram',
    publishDayYmd: '2026-05-25',
    metricsRow: METRICS,
    sourceUrl: 'https://www.instagram.com/p/ABC123/',
    caption: 'x'.repeat(400),
    fetchedAt: '2026-05-27T00:00:00.000Z',
  });
  assert.ok(out);
  assert.ok(out.caption_excerpt.length <= 161, `got ${out.caption_excerpt.length}`); // 160 + ellipsis
  assert.ok(out.caption_excerpt.endsWith('…'));
});

test('missing caption / media type degrade to empty + null, not undefined keys', () => {
  const out = buildPerformancePayloadRecord({
    platform: 'facebook',
    publishDayYmd: '2026-05-25',
    metricsRow: METRICS,
    sourceUrl: 'https://www.facebook.com/p/1',
    fetchedAt: '2026-05-27T00:00:00.000Z',
  });
  assert.ok(out);
  assert.equal(out.caption_excerpt, '');
  assert.equal(out.media_type, null);
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

test('a caption carrying a bare long numeric id is redacted before memory', () => {
  const out = buildPerformancePayloadRecord({
    platform: 'instagram',
    publishDayYmd: '2026-05-25',
    metricsRow: METRICS,
    sourceUrl: 'https://www.instagram.com/p/ABC123/',
    caption: '17900000000000000',
    fetchedAt: '2026-05-27T00:00:00.000Z',
  });
  assert.ok(out);
  assert.ok(!JSON.stringify(out).includes('17900000000000000'));
});
