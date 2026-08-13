import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveTopAvailability,
  shouldComputeWeakest,
  weakestMetricValue,
} from '../backend/insights/top/top-snapshot-builder';
import { postEngagementPercent, POST_ENGAGEMENT_PERCENT_SQL } from '../backend/insights/post-engagement-percent';

// AA-229 PR2a — weakest-post card + two-reason empty state for Section 6.
//
// Pure/deterministic, no DB — runs in `npm run verify`. The live-Postgres
// fixtures proving F1 (unmeasured posts excluded), F2 (deterministic tie
// break) and F3 (best/weakest collision dropped) against real rows live in
// tests/insights-top-weakest.requires-infra.test.ts — those properties are
// about SQL predicates and row selection, which a mock cannot meaningfully
// exercise (see that file's header for why).
//
// Review note (F4): an earlier version of this file asserted numeric parity
// between a hand-typed "SQL mirror" and postEngagementPercent() — but the
// mirror was line-for-line the same formula, so the grid asserted f(x)===f(x)
// and never actually referenced the SQL. The fix was structural, not a better
// test: the weakest query's `metric` is now ALWAYS computed in JS by
// weakestMetricValue() (below) from the raw per-post counts, using the same
// postEngagementPercent() every top-5 row uses — the SQL expression
// (POST_ENGAGEMENT_PERCENT_SQL) is used only for `ORDER BY`, never read back
// as a value. So the routing test below (which field weakestMetricValue picks
// per sortBy) is what's actually load-bearing, not a numeric-agreement test.

test('POST_ENGAGEMENT_PERCENT_SQL pins the exact SQL expression used for the weakest-post ORDER BY', () => {
  assert.equal(
    POST_ENGAGEMENT_PERCENT_SQL,
    'ROUND(COALESCE((likes + comments + saves + shares)::numeric / NULLIF(reach, 0), 0) * 1000) / 10',
  );
});

test('weakestMetricValue routes each sortBy to the correct raw field (no accidental swap)', () => {
  // Every field carries a DISTINCT value so a routing mistake (e.g. shares
  // read for saves) is caught, not masked by equal fixture values.
  const raw = { reach: 1000, likes: 11, comments: 22, saves: 33, shares: 44 };

  assert.equal(weakestMetricValue('reach', raw), 1000);
  assert.equal(weakestMetricValue('saves', raw), 33);
  assert.equal(weakestMetricValue('shares', raw), 44);
  assert.equal(weakestMetricValue('comments', raw), 22);
  // 'engagement' delegates to the SAME function deriveTopPostMetrics() calls
  // for every top-5 row — asserted by direct comparison, not re-derived.
  assert.equal(weakestMetricValue('engagement', raw), postEngagementPercent(raw));
});

test('shouldComputeWeakest: omitted when postCount < 2 (best === weakest would mislead)', () => {
  assert.equal(shouldComputeWeakest(0), false);
  assert.equal(shouldComputeWeakest(1), false);
  assert.equal(shouldComputeWeakest(2), true);
  assert.equal(shouldComputeWeakest(10), true);
});

test('deriveTopAvailability: maps account/metric-row existence to the two documented reasons', () => {
  assert.deepEqual(deriveTopAvailability(false, false), {
    insightsConnected: false,
    reason: 'insights_not_connected',
  });
  assert.deepEqual(deriveTopAvailability(true, false), {
    insightsConnected: false,
    reason: 'insights_not_connected',
  });
  assert.deepEqual(deriveTopAvailability(false, true), {
    insightsConnected: false,
    reason: 'insights_not_connected',
  });
  assert.deepEqual(deriveTopAvailability(true, true), {
    insightsConnected: true,
    reason: 'no_posts_in_window',
  });
});
