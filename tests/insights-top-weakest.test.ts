import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveTopPostMetrics,
  deriveTopAvailability,
  shouldComputeWeakest,
} from '../backend/insights/top/top-snapshot-builder';
import {
  postEngagementPercent,
  POST_ENGAGEMENT_PERCENT_SQL,
} from '../backend/insights/post-engagement-percent';

// AA-229 PR2a — weakest-post card + two-reason empty state for Section 6.
//
// Pure/deterministic, no DB — runs in `npm run verify`. Covers the two
// highest-risk pieces described in the plan:
//   1. Engagement-metric parity between the SQL expression used to rank the
//      weakest post in Postgres (POST_ENGAGEMENT_PERCENT_SQL) and the single
//      JS formula (postEngagementPercent, consumed by deriveTopPostMetrics)
//      used to rank/display the top posts — these must never silently
//      diverge (see backend/insights/post-engagement-percent.ts for why this
//      is a single-source module rather than two hand-typed re-derivations —
//      the exact shape of bug that shipped AA-231 three times).
//   2. The `postCount < 2` omission rule and the availability→reason mapping
//      that drives the two-reason empty state.

// Mirrors the numeric semantics of POST_ENGAGEMENT_PERCENT_SQL for the
// non-negative operand domain this query always sees (reach/likes/comments/
// saves/shares are never negative), where Postgres' ROUND(numeric)
// (round-half-away-from-zero) and JS Math.round (round-half-up) agree. This
// is the one unavoidable second implementation (there is no way to execute
// literal SQL in a DB-free unit test) — it is deliberately validated against
// postEngagementPercent(), the single canonical JS formula, rather than a
// second hand-typed copy of the ratio/rounding math.
function engagementSqlMirror(raw: {
  reach: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
}): number {
  const interactions = raw.likes + raw.comments + raw.saves + raw.shares;
  const ratio = raw.reach > 0 ? interactions / raw.reach : 0;
  return Math.round(ratio * 1000) / 10;
}

test('POST_ENGAGEMENT_PERCENT_SQL pins the exact SQL expression used for the weakest-post ORDER BY', () => {
  assert.equal(
    POST_ENGAGEMENT_PERCENT_SQL,
    'ROUND(COALESCE((likes + comments + saves + shares)::numeric / NULLIF(reach, 0), 0) * 1000) / 10',
  );
});

test('engagement parity: SQL-mirrored formula agrees with postEngagementPercent() across a fixture grid', () => {
  const grid = [
    { reach: 100, likes: 10, comments: 5, saves: 3, shares: 2 },
    { reach: 80, likes: 5, comments: 0, saves: 0, shares: 0 },
    { reach: 0, likes: 5, comments: 1, saves: 1, shares: 1 }, // reach=0 divisor guard
    { reach: 1, likes: 0, comments: 0, saves: 0, shares: 0 }, // zero interactions
    { reach: 3, likes: 1, comments: 0, saves: 0, shares: 0 }, // 33.33% rounding boundary
    { reach: 7, likes: 1, comments: 0, saves: 0, shares: 0 }, // 14.2857% rounding boundary
    { reach: 200, likes: 50, comments: 30, saves: 20, shares: 10 }, // clean 55%
    { reach: 1_000_000, likes: 1, comments: 0, saves: 0, shares: 0 }, // rounds to 0
    { reach: 6, likes: 1, comments: 0, saves: 0, shares: 0 }, // 16.666...% -> .5 rounding edge
  ];

  for (const raw of grid) {
    const expected = postEngagementPercent(raw);
    const actual = engagementSqlMirror(raw);
    assert.equal(actual, expected, `engagement mismatch for ${JSON.stringify(raw)}`);
    // deriveTopPostMetrics delegates to postEngagementPercent — assert it
    // hasn't silently grown its own copy of the formula again.
    assert.equal(deriveTopPostMetrics(raw, 0).engagement, expected);
  }
});

test('shouldComputeWeakest: omitted when postCount < 2 (best === weakest would mislead)', () => {
  assert.equal(shouldComputeWeakest(0), false);
  assert.equal(shouldComputeWeakest(1), false);
  assert.equal(shouldComputeWeakest(2), true);
  assert.equal(shouldComputeWeakest(10), true);
});

test('deriveTopAvailability: maps account/metric-row presence to the two documented reasons', () => {
  assert.deepEqual(deriveTopAvailability(0, 0), {
    insightsConnected: false,
    reason: 'insights_not_connected',
  });
  assert.deepEqual(deriveTopAvailability(1, 0), {
    insightsConnected: false,
    reason: 'insights_not_connected',
  });
  assert.deepEqual(deriveTopAvailability(0, 5), {
    insightsConnected: false,
    reason: 'insights_not_connected',
  });
  assert.deepEqual(deriveTopAvailability(1, 5), {
    insightsConnected: true,
    reason: 'no_posts_in_window',
  });
});
