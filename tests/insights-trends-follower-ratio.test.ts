import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFollowerRatioLine } from '../backend/insights/trends/follower-ratio';
import { buildMetricDisplays } from '../backend/insights/trends/trends-template-builder';
import type { TrendsSnapshot } from '../backend/insights/trends/trends-snapshot-builder';

// AA-246 — the Trends Reach-tab ratio copy ("Nx your follower base of …" /
// "N% of your N followers") must divide against the tenant's actual current
// follower count (TrendsSnapshot.followerBase), never the period's follower
// DELTA (snap.followers.value = SUM(followers_delta)), and must never assert
// a claim against a non-positive/unknown base. Pure + no DB — runs in
// `npm run verify` on every PR (registered in verify-regression-suite.mjs).
//
// Root cause (qa-defect #818, "8200% of 0 followers"): the old code read
// snap.followers.value as the base and clamped the DENOMINATOR to
// Math.max(1, …) on a non-positive delta while still printing the raw
// (possibly 0/negative) value in the copy — the clamp hid the divide-by-zero
// without hiding the fabricated claim.

const trivialFormat = (n: number) => String(n);

// ── 1. buildFollowerRatioLine — pure helper unit tests ─────────────────────────

test('buildFollowerRatioLine: followerBase = 0 suppresses the line entirely', () => {
  const line = buildFollowerRatioLine(82, 0, trivialFormat);
  assert.equal(line, null, 'a zero base must not produce a formatted-zero or clamped percentage');
});

test('buildFollowerRatioLine: followerBase = null suppresses the line entirely', () => {
  const line = buildFollowerRatioLine(82, null, trivialFormat);
  assert.equal(line, null, 'an unknown base must not produce any ratio claim');
});

test('buildFollowerRatioLine: followerBase = undefined also suppresses (defensive)', () => {
  assert.equal(buildFollowerRatioLine(82, undefined, trivialFormat), null);
});

test('buildFollowerRatioLine: negative followerBase (should never happen, but defensive) suppresses', () => {
  assert.equal(buildFollowerRatioLine(82, -5, trivialFormat), null);
});

test('buildFollowerRatioLine: prod shape (tenant 15) — base=2, reach=82 — never a % above 100, never negative', () => {
  // Verified on prod tenant 15 (2026-08-13): real follower base = 2, while the
  // OLD code's substitute (SUM(followers_delta) over 90d) = -1, which is
  // exactly the shape that produced "8200% of 0 followers" under the old
  // Math.max(1, …) clamp. With the real base, reach 82 / base 2 = 41x — no
  // percentage is ever printed in the >=1x branch, so "8200%" cannot occur.
  const line = buildFollowerRatioLine(82, 2, trivialFormat);
  assert.equal(line, '41x your follower base of 2');
  assert.doesNotMatch(line!, /%/, 'the x-multiple branch never prints a percentage');
  assert.doesNotMatch(line!, /-\d/, 'never a negative number in the copy');
  assert.doesNotMatch(line!, /8200/, 'the literal reported bug string must not occur');
});

test('buildFollowerRatioLine: below-base reach renders the percent-of-followers branch, not a hardcoded delta', () => {
  // followerBase = 5000, reach = 2500 → 50%. The period follower DELTA (+80 in
  // the incident's fixture) plays no part in this function's signature at
  // all, so it structurally cannot leak into the string.
  const line = buildFollowerRatioLine(2500, 5000, trivialFormat);
  assert.equal(line, 'reached 50% of your 5000 followers');
  assert.doesNotMatch(line!, /\b80\b/, 'nothing in the string derives from the unrelated follower delta');
});

test('buildFollowerRatioLine: above-base reach renders the "Nx your follower base" branch', () => {
  const line = buildFollowerRatioLine(2500, 1000, trivialFormat);
  assert.equal(line, '2.5x your follower base of 1000');
});

test('buildFollowerRatioLine: percentage branch never reaches or exceeds 100% (rounding routes borderline cases to the x-branch)', () => {
  for (const [value, base] of [[1, 2], [999, 1000], [1, 1000], [0, 100]] as const) {
    const line = buildFollowerRatioLine(value, base, trivialFormat);
    const pctMatch = line?.match(/reached (\d+)% of/);
    if (pctMatch) {
      assert.ok(Number(pctMatch[1]) < 100, `percentage ${pctMatch[1]} must stay under 100 for value=${value} base=${base}`);
    }
  }
});

// ── 2. Integration: buildMetricDisplays threads TrendsSnapshot.followerBase ────
// through to the rendered "supporting" copy on the Reach tab.

function fixtureSnapshot(overrides: Partial<TrendsSnapshot>): TrendsSnapshot {
  const emptySeries = { current: [], prior: [], labels: [] };
  const base: TrendsSnapshot = {
    reach:      { value: 82, valuePrev: 80, delta: 3 },
    engagement: { value: 4.2, valuePrev: 4.0, delta: 0.2 },
    followers:  { value: -1, valuePrev: 5, delta: null },
    followerBase: 2,
    comments:   { value: 10, valuePrev: 8, delta: null },
    visits:     null,
    series: {
      reach: emptySeries, engagement: emptySeries, followers: emptySeries,
      comments: emptySeries, visits: null,
    },
    platformBreakdown: {
      reach: [], followers: [], engagement: [], comments: [], visits: null,
    },
    postCount:            5,
    unreplied:             0,
    sentimentPositivePct:  0,
    topPostTitle:          null,
    engagementBaseline:    3.5,
    visitsAvailable:       false,
  };
  return { ...base, ...overrides };
}

test('buildMetricDisplays: prod shape (followerBase=2, followers delta=-1, reach=82) never renders a % ratio claim or a negative follower count', () => {
  const snap = fixtureSnapshot({});
  const displays = buildMetricDisplays(snap, 'week', 'all');
  const supporting = displays.reach.supporting;
  // Scope the "no %" check to the ratio CLAUSE specifically — the reach
  // delta's own "+3% vs prior" badge is unrelated and legitimately has a %.
  assert.doesNotMatch(supporting, /reached \d+% of/, 'no percent-of-followers ratio claim for this reach/base pair');
  assert.doesNotMatch(supporting, /-1\b/, 'the negative follower delta must not leak into the ratio copy');
  assert.doesNotMatch(supporting, /8200/, 'the exact reported bug string must not occur');
  assert.match(supporting, /41x your follower base of 2/, 'ratio divides against the real base, not the delta');
});

test('buildMetricDisplays: followerBase=0 suppresses the ratio clause without a dangling separator', () => {
  const snap = fixtureSnapshot({ followerBase: 0 });
  const displays = buildMetricDisplays(snap, 'week', 'all');
  const supporting = displays.reach.supporting;
  assert.doesNotMatch(supporting, /reached \d+% of/, 'no percent-of-followers claim when the base is unknown');
  assert.doesNotMatch(supporting, /follower base/, 'no ratio clause at all when the base is unknown');
  assert.doesNotMatch(supporting, /·\s*$/, 'no trailing bare separator with nothing after it');
  assert.equal(supporting, '<span class="pos">+3% vs prior</span>', 'delta badge renders alone with no ratio clause appended');
});

test('buildMetricDisplays: followerBase=5000, reach=2500 renders "50% of your 5000 followers" — nothing derives from the unrelated +80 delta', () => {
  const snap = fixtureSnapshot({
    reach:      { value: 2500, valuePrev: 2000, delta: 25 },
    followers:  { value: 80, valuePrev: 10, delta: null },
    followerBase: 5000,
  });
  const displays = buildMetricDisplays(snap, 'week', 'all');
  assert.match(displays.reach.supporting, /reached 50% of your 5K followers/);
  assert.doesNotMatch(displays.reach.supporting, /\b80\b/, 'the +80 follower delta must not appear in the ratio copy');
});

test('buildMetricDisplays: followerBase=1000, reach=2500 renders the 2.5x branch', () => {
  const snap = fixtureSnapshot({
    reach:        { value: 2500, valuePrev: 2000, delta: 25 },
    followerBase: 1000,
  });
  const displays = buildMetricDisplays(snap, 'week', 'all');
  assert.match(displays.reach.supporting, /2\.5x your follower base of 1K/);
});
