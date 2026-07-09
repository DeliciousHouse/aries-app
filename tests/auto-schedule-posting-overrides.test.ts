/**
 * AI posting-time overrides in the auto-schedule slot computation
 * (backend/marketing/auto-schedule.ts). Pure-function tests — no DB, no clock:
 * both compute paths take injectable `now`.
 *
 * The load-bearing invariant: NO overrides → byte-identical output to today
 * (the flag-off golden), and overrides only ever move the feed hour/minute
 * (+ ranked preferred days on the default-cadence path when honoring them
 * cannot drop post volume).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeAutoScheduleSlots,
  computeDefaultCadenceSlots,
  resolveSlotDefault,
  PLATFORM_POSTING_DEFAULTS,
  type AutoScheduleInputRow,
  type DefaultCadenceInputRow,
} from '../backend/marketing/auto-schedule';

// Monday 2026-07-06 00:00 in America/New_York is 04:00Z. Every derived hour of
// interest (9-20 local) is comfortably after `now`, so no day-shift noise.
const NOW = new Date('2026-07-06T04:00:00Z');
const WINDOW_START = NOW;
const WINDOW_END = new Date('2026-07-20T04:00:00Z'); // 14 days

const TZ = 'America/New_York';

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

// ── resolveSlotDefault ──────────────────────────────────────────────────────

test('resolveSlotDefault: no overrides → identical to the platform default', () => {
  assert.deepEqual(
    resolveSlotDefault('instagram', 'feed', undefined),
    PLATFORM_POSTING_DEFAULTS.instagram.feed,
  );
  assert.deepEqual(
    resolveSlotDefault('facebook', 'story', {}),
    PLATFORM_POSTING_DEFAULTS.facebook.story,
  );
});

test('resolveSlotDefault: feed override applies; story/reel keep platform defaults', () => {
  const overrides = { instagram: { hour: 19, minute: 30, days: [] } };
  assert.deepEqual(resolveSlotDefault('instagram', 'feed', overrides), {
    hour: 19,
    minute: 30,
    staggerMinutes: PLATFORM_POSTING_DEFAULTS.instagram.feed.staggerMinutes,
  });
  assert.deepEqual(
    resolveSlotDefault('instagram', 'story', overrides),
    PLATFORM_POSTING_DEFAULTS.instagram.story,
    'a story must not follow the feed override',
  );
});

test('resolveSlotDefault: override minute is clamped so minute+stagger stays a valid wall-clock minute', () => {
  // facebook feed stagger is 5 — minute 58 would render an invalid ":63".
  const slot = resolveSlotDefault('facebook', 'feed', { facebook: { hour: 13, minute: 58, days: [] } });
  assert.ok(slot);
  assert.equal(slot.minute + slot.staggerMinutes <= 59, true);
  assert.equal(slot.minute, 54);
});

test('resolveSlotDefault: out-of-range override hour falls back to the platform default hour', () => {
  const slot = resolveSlotDefault('instagram', 'feed', { instagram: { hour: 99 as number, minute: 0, days: [] } });
  assert.ok(slot);
  assert.equal(slot.hour, PLATFORM_POSTING_DEFAULTS.instagram.feed.hour);
});

// ── computeAutoScheduleSlots (strategist weekly_schedule path) ──────────────

const STRATEGIST_ROWS: AutoScheduleInputRow[] = [
  { postId: 1, platform: 'instagram', recommendedDay: 'Wednesday' },
  { postId: 2, platform: 'facebook', recommendedDay: 'Wednesday' },
];

test('strategist path: override moves the hour, the strategist day still wins', () => {
  const result = computeAutoScheduleSlots({
    rows: STRATEGIST_ROWS,
    tenantTimezone: TZ,
    campaignStart: WINDOW_START,
    campaignEnd: WINDOW_END,
    now: NOW,
    slotOverrides: { instagram: { hour: 19, minute: 0, days: [5] } },
  });
  assert.equal(result.slots.length, 2);
  const ig = result.slots.find((s) => s.platform === 'instagram')!;
  const igLocal = localDayAndTime(ig.scheduledFor);
  assert.equal(igLocal.day, 3, 'strategist Wednesday wins over derived days on this path');
  assert.equal(igLocal.time, '19:00', 'derived hour applies');
  const fb = result.slots.find((s) => s.platform === 'facebook')!;
  assert.equal(localDayAndTime(fb.scheduledFor).time, '13:05', 'un-overridden platform keeps its default');
});

test('strategist path: no overrides is byte-identical to omitting the parameter', () => {
  const base = computeAutoScheduleSlots({
    rows: STRATEGIST_ROWS,
    tenantTimezone: TZ,
    campaignStart: WINDOW_START,
    campaignEnd: WINDOW_END,
    now: NOW,
  });
  const withUndefined = computeAutoScheduleSlots({
    rows: STRATEGIST_ROWS,
    tenantTimezone: TZ,
    campaignStart: WINDOW_START,
    campaignEnd: WINDOW_END,
    now: NOW,
    slotOverrides: undefined,
  });
  assert.deepEqual(withUndefined, base);
});

// ── computeDefaultCadenceSlots (the live weekly path) ───────────────────────

function cadenceRows(count: number, platform = 'instagram'): DefaultCadenceInputRow[] {
  return Array.from({ length: count }, (_, i) => ({
    postId: i + 1,
    platform,
    ordinal: i + 1,
  }));
}

test('default cadence: derived hour replaces the platform hour across the ladder', () => {
  const result = computeDefaultCadenceSlots({
    rows: cadenceRows(3),
    tenantTimezone: TZ,
    campaignStart: WINDOW_START,
    campaignEnd: WINDOW_END,
    now: NOW,
    slotOverrides: { instagram: { hour: 20, minute: 0, days: [] } },
  });
  assert.equal(result.slots.length, 3);
  for (const slot of result.slots) {
    assert.equal(localDayAndTime(slot.scheduledFor).time, '20:00');
    assert.match(slot.appliedDay, /^default-cadence:/, 'no days → the consecutive ladder is unchanged');
  }
});

test('default cadence: preferred days re-anchor a small job onto those days', () => {
  const result = computeDefaultCadenceSlots({
    rows: cadenceRows(2),
    tenantTimezone: TZ,
    campaignStart: WINDOW_START,
    campaignEnd: WINDOW_END,
    now: NOW,
    slotOverrides: { instagram: { hour: 18, minute: 0, days: [3] } }, // Wednesdays
  });
  assert.equal(result.slots.length, 2);
  const sorted = [...result.slots].sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
  for (const slot of sorted) {
    const local = localDayAndTime(slot.scheduledFor);
    assert.equal(local.day, 3, 'both pieces land on a Wednesday');
    assert.equal(local.time, '18:00');
    assert.match(slot.appliedDay, /^preferred-day:/);
  }
  // Ordinal order == calendar order must hold.
  assert.equal(sorted[0].postId, 1);
  assert.equal(sorted[1].postId, 2);
});

test('default cadence: preferred days NEVER drop volume — insufficient matches fall back to the ladder', () => {
  // 7 pieces but only one preferred weekday inside a 14-day window (2 matches)
  // → honoring the preference would strand 5 posts, so the whole pair ladders.
  const result = computeDefaultCadenceSlots({
    rows: cadenceRows(7),
    tenantTimezone: TZ,
    campaignStart: WINDOW_START,
    campaignEnd: WINDOW_END,
    now: NOW,
    slotOverrides: { instagram: { hour: 18, minute: 0, days: [3] } },
  });
  assert.equal(result.slots.length, 7, 'all 7 pieces must still be scheduled');
  for (const slot of result.slots) {
    assert.match(slot.appliedDay, /^default-cadence:/);
    assert.equal(localDayAndTime(slot.scheduledFor).time, '18:00', 'the derived hour still applies on the fallback');
  }
});

test('default cadence: DST fall-back never double-books two ordinals at the same instant (preferred days)', () => {
  // 2026-11-01 is the US fall-back Sunday. now = 00:05 EDT on that day: probes
  // i=0 and i=1 both land on local calendar date Nov 1 (24h UTC later is 23:05
  // EST, same date). Without dedup the preferred-days scan would schedule both
  // ordinals at the identical instant.
  const now = new Date('2026-11-01T04:05:00Z');
  const result = computeDefaultCadenceSlots({
    rows: cadenceRows(2),
    tenantTimezone: TZ,
    campaignStart: now,
    campaignEnd: new Date('2026-11-15T04:05:00Z'),
    now,
    slotOverrides: { instagram: { hour: 11, minute: 0, days: [0] } }, // Sundays
  });
  assert.equal(result.slots.length, 2);
  const instants = result.slots.map((s) => s.scheduledFor.getTime());
  assert.notEqual(instants[0], instants[1], 'two ordinals must never share an exact instant');
  for (const slot of result.slots) {
    assert.equal(localDayAndTime(slot.scheduledFor).day, 0, 'both pieces still land on the preferred Sunday');
    assert.match(slot.appliedDay, /^preferred-day:/);
  }
});

test('default cadence: no overrides is byte-identical to omitting the parameter', () => {
  const rows = [
    ...cadenceRows(3, 'instagram'),
    ...cadenceRows(3, 'facebook'),
  ];
  const base = computeDefaultCadenceSlots({
    rows,
    tenantTimezone: TZ,
    campaignStart: WINDOW_START,
    campaignEnd: WINDOW_END,
    now: NOW,
  });
  const withUndefined = computeDefaultCadenceSlots({
    rows,
    tenantTimezone: TZ,
    campaignStart: WINDOW_START,
    campaignEnd: WINDOW_END,
    now: NOW,
    slotOverrides: undefined,
  });
  assert.deepEqual(withUndefined, base);
});
