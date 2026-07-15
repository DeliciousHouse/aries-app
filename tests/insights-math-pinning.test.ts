import assert from 'node:assert/strict';
import test from 'node:test';

import { tenantZonePeriodStart, tenantZonePeriodStartDateKey } from '../lib/format-timestamp';
import { trendsPctDelta } from '../backend/insights/trends/trends-snapshot-builder';
import { deriveTopPostMetrics, rankTopPosts } from '../backend/insights/top/top-snapshot-builder';

// S2-5 / AA-96 (Gap E5) — deterministic unit tests PINNING the math introduced by
// S2-1 (latest-snapshot metric calcs) and S2-3 (tenant-tz windows), so a future
// refactor can't silently change the numbers. Pure fixtures, no DB — runs in
// `npm run verify` on every PR (added to the curated regression suite).
//
// Seam vs the other tz/metric tests:
//   - S2-4 (insights-tz-boundary-agreement) = cross-section DAY agreement.
//   - requires-infra (S2-1/S2-3) = live SQL (LATERAL, AT TIME ZONE $tz) — self-skip in CI.
//   - S2-5 (this) = per-piece deterministic ARITHMETIC in verify. No overlap.

// ── 1. trends pctDelta — percent-change arithmetic + edge cases ────────────────
// Edge inputs are where this breaks, so they are pinned as first-class cases.
test('trendsPctDelta: divide-by-zero / both-zero / negative-prior all return null', () => {
  assert.equal(trendsPctDelta(100, 0), null, 'prior=0 → null (no divide-by-zero)');
  assert.equal(trendsPctDelta(0, 0), null, 'both-zero → null');
  assert.equal(trendsPctDelta(50, -5), null, 'negative prior → null');
});

test('trendsPctDelta: ordinary deltas round to the nearest integer percent', () => {
  assert.equal(trendsPctDelta(50, 100), -50, 'halving → -50%');
  assert.equal(trendsPctDelta(110, 99), 11, '11.11% → 11 (rounds down)');
  assert.equal(trendsPctDelta(3, 2), 50, '+50%');
});

test('trendsPctDelta: absurd-magnitude cap is strictly > 999 (±999% kept, beyond → null)', () => {
  assert.equal(trendsPctDelta(1000, 1), null, '99900% → null (near-zero baseline blowup)');
  assert.equal(trendsPctDelta(999, 100), 899, '899% is under the cap → kept');
  assert.equal(trendsPctDelta(1099, 100), 999, 'exactly +999% is kept (cutoff is > 999, not >= 999)');
});

// ── 2. goal windows — tenant-tz period-window boundaries (S2-3) ────────────────
// Fixed "now" whose America/New_York (EST, UTC-5) civil day is 2026-01-15. goal
// maps week/30day/90day → 7/30/90 days, and the prior period doubles that.
const NOW = new Date('2026-01-16T04:30:00Z');
const NY = 'America/New_York';

test('goal windows: week/30day/90day current + prior boundaries are pinned per tenant tz', () => {
  // week (7) + prior (14)
  assert.equal(tenantZonePeriodStartDateKey(7, NY, NOW), '2026-01-08');
  assert.equal(tenantZonePeriodStartDateKey(14, NY, NOW), '2026-01-01');
  assert.equal(tenantZonePeriodStart(7, NY, NOW).toISOString(), '2026-01-08T05:00:00.000Z');
  // 30day (30) + prior (60)
  assert.equal(tenantZonePeriodStartDateKey(30, NY, NOW), '2025-12-16');
  assert.equal(tenantZonePeriodStartDateKey(60, NY, NOW), '2025-11-16');
  // 90day (90) + prior (180)
  assert.equal(tenantZonePeriodStartDateKey(90, NY, NOW), '2025-10-17');
  assert.equal(tenantZonePeriodStartDateKey(180, NY, NOW), '2025-07-19');
});

test('goal windows: DST correctness — historical windows anchor at THAT date’s offset (EDT vs EST)', () => {
  // 7/30/60 days back land in winter → EST (UTC-5) → midnight is 05:00Z.
  assert.equal(tenantZonePeriodStart(30, NY, NOW).toISOString(), '2025-12-16T05:00:00.000Z');
  assert.equal(tenantZonePeriodStart(60, NY, NOW).toISOString(), '2025-11-16T05:00:00.000Z');
  // 90/180 days back land BEFORE the Nov 1 fall-back → EDT (UTC-4) → midnight is
  // 04:00Z. Freezing the offset difference guards the per-date DST resolution.
  assert.equal(tenantZonePeriodStart(90, NY, NOW).toISOString(), '2025-10-17T04:00:00.000Z');
  assert.equal(tenantZonePeriodStart(180, NY, NOW).toISOString(), '2025-07-19T04:00:00.000Z');
});

test('goal windows: a "now" ON the spring-forward day resolves at tenant midnight', () => {
  // US spring-forward 2026-03-08 (02:00→03:00). Midnight 03-08 is still EST → 05:00Z.
  const dstNow = new Date('2026-03-08T12:00:00Z'); // NY civil day = 2026-03-08
  assert.equal(tenantZonePeriodStartDateKey(0, NY, dstNow), '2026-03-08');
  assert.equal(tenantZonePeriodStart(0, NY, dstNow).toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(tenantZonePeriodStart(7, NY, dstNow).toISOString(), '2026-03-01T05:00:00.000Z');
});

// ── 3. top ranking — latest-snapshot derived metrics + ordering (S2-1) ─────────
test('deriveTopPostMetrics: engagement / saveRate / multiplier arithmetic + rounding', () => {
  assert.deepEqual(
    deriveTopPostMetrics({ reach: 100, likes: 10, comments: 5, saves: 3, shares: 2 }, 50),
    { engagement: 20, saveRate: 3, multiplier: 2 },
  );
  // engagement rounds to 1 decimal: 5/80 = 6.25% → 6.3 ; multiplier 80/50 = 1.6
  assert.deepEqual(
    deriveTopPostMetrics({ reach: 80, likes: 5, comments: 0, saves: 0, shares: 0 }, 50),
    { engagement: 6.3, saveRate: 0, multiplier: 1.6 },
  );
});

test('deriveTopPostMetrics: divisor guards (reach=0 and avgReach=0 never divide)', () => {
  assert.deepEqual(
    deriveTopPostMetrics({ reach: 0, likes: 5, comments: 1, saves: 1, shares: 1 }, 50),
    { engagement: 0, saveRate: 0, multiplier: 0 },
  );
  assert.equal(
    deriveTopPostMetrics({ reach: 100, likes: 1, comments: 0, saves: 0, shares: 0 }, 0).multiplier,
    0,
    'avgReach=0 → multiplier 0 (no divide)',
  );
});

test('rankTopPosts: engagement re-sorts desc and trims to top 5', () => {
  const posts = [
    { id: 1, engagement: 20 }, { id: 2, engagement: 35 }, { id: 3, engagement: 35 },
    { id: 4, engagement: 10 }, { id: 5, engagement: 50 }, { id: 6, engagement: 5 },
    { id: 7, engagement: 40 },
  ];
  const ranked = rankTopPosts(posts, 'engagement');
  assert.equal(ranked.length, 5, 'trimmed to top 5');
  // Deterministic (non-tied) positions:
  assert.equal(ranked[0].id, 5, 'highest engagement (50) first');
  assert.equal(ranked[1].id, 7, 'next (40)');
  assert.equal(ranked[4].id, 1, 'fifth is engagement 20');
  // The two engagement=35 posts (ids 2,3) TIE. Ordering among exact-metric ties is
  // NOT deterministic today (no tie-breaker), so assert only MEMBERSHIP — pinning
  // an exact tie order would pin luck. (Follow-up: add an id-asc tie-breaker.)
  assert.deepEqual(
    new Set(ranked.slice(2, 4).map((p) => p.id)),
    new Set([2, 3]),
    'both tied (35) posts occupy the middle two slots, order unspecified',
  );
});

test('rankTopPosts: non-engagement keys trust incoming DB order and trim to 5', () => {
  // For non-engagement sort keys the DB ORDER BY is authoritative; rankTopPosts
  // preserves the incoming order and trims. (Behavior-identical to pre-S2-5.)
  const posts = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, engagement: 0 }));
  const ranked = rankTopPosts(posts, 'reach');
  assert.deepEqual(ranked.map((p) => p.id), [1, 2, 3, 4, 5], 'input order preserved, first 5 kept');
});
