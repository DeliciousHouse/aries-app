/**
 * Analytics day blend on the strategist scheduling path
 * (backend/marketing/auto-schedule.ts, audit item 4b).
 *
 * The contract under test: the strategist's `recommended_day` is the DEFAULT
 * and only the tenant's OWN measured engagement may move it, by at most 2
 * calendar days, on the feed surface, and never onto a slot another post's
 * explicit strategist day has already claimed.
 *
 * Every test is pure — injected `now`, no DB, no clock, no env.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blendStrategistDayWithRankings,
  computeAutoScheduleSlots,
  isScheduleDayBlendEnabled,
  MAX_DAY_BLEND_SHIFT,
  MIN_RANKED_DAYS_FOR_BLEND,
  type AutoScheduleInputRow,
  type PostingTimeSlotOverrides,
} from '../backend/marketing/auto-schedule';

// Monday 2026-07-06 00:00 in America/New_York is 04:00Z. Every derived hour of
// interest (9-20 local) is comfortably after `now`, so no day-shift noise.
const NOW = new Date('2026-07-06T04:00:00Z');
const WINDOW_START = NOW;
const WINDOW_END = new Date('2026-07-20T04:00:00Z'); // 14 days
const TZ = 'America/New_York';

const SUN = 0;
const MON = 1;
const TUE = 2;
const WED = 3;
const THU = 4;
const FRI = 5;
const SAT = 6;

function localDayAndTime(instant: Date): { day: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day: dayIndex, time: `${get('hour')}:${get('minute')}` };
}

function compute(
  rows: AutoScheduleInputRow[],
  slotOverrides?: PostingTimeSlotOverrides,
  dayBlendEnabled?: boolean,
) {
  return computeAutoScheduleSlots({
    rows,
    tenantTimezone: TZ,
    campaignStart: WINDOW_START,
    campaignEnd: WINDOW_END,
    now: NOW,
    slotOverrides,
    dayBlendEnabled,
  });
}

// ── blendStrategistDayWithRankings (pure decision) ──────────────────────────

test('blend: no ranked days → no_signal, strategist day untouched', () => {
  assert.deepEqual(blendStrategistDayWithRankings(WED, []), {
    day: WED,
    moved: false,
    reason: 'no_signal',
  });
});

test('blend: a single ranked day is not a ranking → weak_signal', () => {
  // `marketing_posting_times.days` is a top-3 best-first list. One entry says
  // "this day was good", never "the strategist's day is bad".
  assert.equal(MIN_RANKED_DAYS_FOR_BLEND, 2);
  assert.deepEqual(blendStrategistDayWithRankings(WED, [FRI]), {
    day: WED,
    moved: false,
    reason: 'weak_signal',
  });
});

test('blend: strategist day is itself ranked → kept, signals agree', () => {
  assert.deepEqual(blendStrategistDayWithRankings(WED, [WED, SAT]), {
    day: WED,
    moved: false,
    reason: 'strategist_ranked',
    rank: 0,
  });
  assert.deepEqual(blendStrategistDayWithRankings(WED, [SAT, WED]), {
    day: WED,
    moved: false,
    reason: 'strategist_ranked',
    rank: 1,
  });
});

test('blend: unranked strategist day moves to the nearest ranked day', () => {
  // Sunday(0) is 3 days from Wednesday (too far); Thursday(4) is +1.
  assert.deepEqual(blendStrategistDayWithRankings(WED, [SUN, THU]), {
    day: THU,
    moved: true,
    reason: 'nudged',
    rank: 1,
    shift: 1,
  });
});

test('blend: equidistant candidates are broken by RANK, never by direction', () => {
  // Friday(5) is +2, Monday(1) is -2 — a tie on distance. Friday is rank 0.
  assert.deepEqual(blendStrategistDayWithRankings(WED, [FRI, MON]), {
    day: FRI,
    moved: true,
    reason: 'nudged',
    rank: 0,
    shift: 2,
  });
  // Tuesday(2) is -1, Thursday(4) is +1 — a tie again. Tuesday is rank 0, so
  // Tuesday wins even though Thursday is the FORWARD day. Rank position is
  // unique per candidate, so distance+rank is a total order: there is no
  // secondary "prefer later" tie-break, and none is needed.
  assert.deepEqual(blendStrategistDayWithRankings(WED, [TUE, THU]), {
    day: TUE,
    moved: true,
    reason: 'nudged',
    rank: 0,
    shift: -1,
  });
  // Reversing the ranking reverses the winner — proving rank, not direction,
  // decides.
  assert.deepEqual(blendStrategistDayWithRankings(WED, [THU, TUE]), {
    day: THU,
    moved: true,
    reason: 'nudged',
    rank: 0,
    shift: 1,
  });
});

test('blend: every ranked day more than MAX_DAY_BLEND_SHIFT away → too_far', () => {
  assert.equal(MAX_DAY_BLEND_SHIFT, 2);
  // Saturday(6) is +3, Sunday(0) is -3. Both exceed the cap.
  assert.deepEqual(blendStrategistDayWithRankings(WED, [SAT, SUN]), {
    day: WED,
    moved: false,
    reason: 'too_far',
  });
});

test('blend: out-of-range day entries are discarded before ranking', () => {
  // 9 is not a weekday index; after filtering the list is [Fri, Mon] and Friday
  // is rank 0 of the SURVIVING list.
  assert.deepEqual(blendStrategistDayWithRankings(WED, [9, FRI, MON]), {
    day: FRI,
    moved: true,
    reason: 'nudged',
    rank: 0,
    shift: 2,
  });
  // A list that filters down to one entry is weak, not usable.
  assert.equal(blendStrategistDayWithRankings(WED, [9, -1, FRI]).reason, 'weak_signal');
});

// ── computeAutoScheduleSlots integration ────────────────────────────────────

const IG_WED: AutoScheduleInputRow[] = [{ postId: 1, platform: 'instagram', recommendedDay: 'Wednesday' }];

const ANALYTICS_FRI_MON: PostingTimeSlotOverrides = {
  instagram: { hour: 11, minute: 0, days: [FRI, MON], source: 'analytics' },
};
const COMPETITOR_FRI_MON: PostingTimeSlotOverrides = {
  instagram: { hour: 11, minute: 0, days: [FRI, MON], source: 'competitor' },
};
const NO_SOURCE_FRI_MON: PostingTimeSlotOverrides = {
  instagram: { hour: 11, minute: 0, days: [FRI, MON] },
};

test('integration: analytics-sourced ranking nudges Wednesday onto Friday', () => {
  const result = compute(IG_WED, ANALYTICS_FRI_MON);
  assert.equal(result.slots.length, 1);
  const slot = result.slots[0];
  assert.equal(localDayAndTime(slot.scheduledFor).day, FRI);
  assert.match(slot.appliedDay, /analytics-blend/);
  assert.match(slot.appliedDay, /Wednesday → Friday/);
  assert.match(slot.appliedDay, /rank 1, \+2d/);
});

test('integration: competitor-sourced ranking never moves the day', () => {
  const result = compute(IG_WED, COMPETITOR_FRI_MON);
  assert.equal(localDayAndTime(result.slots[0].scheduledFor).day, WED);
  assert.equal(result.slots[0].appliedDay, 'Wednesday');
});

test('integration: an override with no `source` is treated as competitor (provenance golden)', () => {
  // Rows written before the `source` column was surfaced must not silently
  // acquire the power to move a strategist day.
  assert.deepEqual(compute(IG_WED, NO_SOURCE_FRI_MON), compute(IG_WED, COMPETITOR_FRI_MON));
  // …and, because the override hour here IS the instagram feed default,
  // identical to running with no overrides at all.
  assert.deepEqual(compute(IG_WED, NO_SOURCE_FRI_MON), compute(IG_WED, undefined));
});

test('integration: the blend is DAY-only — story surface keeps the strategist day', () => {
  const result = compute(
    [{ postId: 1, platform: 'instagram', recommendedDay: 'Wednesday', surface: 'story' }],
    ANALYTICS_FRI_MON,
  );
  const local = localDayAndTime(result.slots[0].scheduledFor);
  assert.equal(local.day, WED, 'story surface is out of scope for the blend');
  assert.equal(local.time, '09:00', 'story also keeps its platform-default hour');
});

test('integration: a nudged day outside the campaign window falls back to the strategist day', () => {
  // Window closes Thursday, so the Friday nudge target never occurs.
  const result = computeAutoScheduleSlots({
    rows: IG_WED,
    tenantTimezone: TZ,
    campaignStart: WINDOW_START,
    campaignEnd: new Date('2026-07-09T23:59:00Z'),
    now: NOW,
    slotOverrides: ANALYTICS_FRI_MON,
  });
  assert.equal(result.slots.length, 1, 'the post is scheduled, not skipped');
  assert.equal(localDayAndTime(result.slots[0].scheduledFor).day, WED);
  assert.equal(result.slots[0].appliedDay, 'Wednesday');
});

test('integration: a nudge is ABANDONED rather than stealing a sibling\'s strategist day', () => {
  // The order-dependence trap: row 1 (Wednesday) would nudge onto Friday, which
  // is free at that instant because `used` only sees already-processed rows.
  // Row 2's Friday is strategist_ranked, so it would then collide with its own
  // sibling and get de-collided off its explicitly chosen day. The pre-pass
  // reservation prevents that.
  const rows: AutoScheduleInputRow[] = [
    { postId: 1, platform: 'instagram', recommendedDay: 'Wednesday' },
    { postId: 2, platform: 'instagram', recommendedDay: 'Friday' },
  ];
  const result = compute(rows, ANALYTICS_FRI_MON);
  assert.equal(result.slots.length, 2);
  const days = result.slots.map((s) => localDayAndTime(s.scheduledFor).day);
  assert.deepEqual(days, [WED, FRI], 'each post keeps a distinct, intended day');
  for (const slot of result.slots) {
    assert.doesNotMatch(slot.appliedDay, /de-collided/, 'no post was pushed off its day');
    assert.doesNotMatch(slot.appliedDay, /analytics-blend/, 'the nudge was abandoned, not applied');
  }
});

test('integration: reversing row order gives the identical result (order-independence)', () => {
  const forward = compute(
    [
      { postId: 1, platform: 'instagram', recommendedDay: 'Wednesday' },
      { postId: 2, platform: 'instagram', recommendedDay: 'Friday' },
    ],
    ANALYTICS_FRI_MON,
  );
  const reversed = compute(
    [
      { postId: 2, platform: 'instagram', recommendedDay: 'Friday' },
      { postId: 1, platform: 'instagram', recommendedDay: 'Wednesday' },
    ],
    ANALYTICS_FRI_MON,
  );
  const byPost = (r: typeof forward) =>
    [...r.slots].sort((a, b) => a.postId - b.postId).map((s) => [s.postId, s.appliedWallTime]);
  assert.deepEqual(byPost(reversed), byPost(forward));
});

// ── kill switch ─────────────────────────────────────────────────────────────

test('kill switch: dayBlendEnabled=false is byte-identical to the no-blend path', () => {
  const off = compute(IG_WED, ANALYTICS_FRI_MON, false);
  // Same override (so the same derived hour), but provenance that can never
  // blend — i.e. exactly the pre-change behavior.
  assert.deepEqual(off, compute(IG_WED, COMPETITOR_FRI_MON));
  assert.equal(localDayAndTime(off.slots[0].scheduledFor).day, WED);
  assert.equal(off.slots[0].appliedDay, 'Wednesday');
});

test('kill switch: dayBlendEnabled defaults to ON when omitted', () => {
  assert.deepEqual(compute(IG_WED, ANALYTICS_FRI_MON, undefined), compute(IG_WED, ANALYTICS_FRI_MON, true));
});

test('isScheduleDayBlendEnabled: default ON; only explicit off-tokens disable', () => {
  assert.equal(isScheduleDayBlendEnabled({}), true, 'unset → ON');
  assert.equal(isScheduleDayBlendEnabled({ ARIES_SCHEDULE_DAY_BLEND_ENABLED: '' }), true);
  assert.equal(isScheduleDayBlendEnabled({ ARIES_SCHEDULE_DAY_BLEND_ENABLED: '1' }), true);
  assert.equal(isScheduleDayBlendEnabled({ ARIES_SCHEDULE_DAY_BLEND_ENABLED: 'true' }), true);
  for (const off of ['0', 'false', 'no', 'off', 'OFF', ' 0 ']) {
    assert.equal(
      isScheduleDayBlendEnabled({ ARIES_SCHEDULE_DAY_BLEND_ENABLED: off }),
      false,
      `${JSON.stringify(off)} must disable the blend`,
    );
  }
});
