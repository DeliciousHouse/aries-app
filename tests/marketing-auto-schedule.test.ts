import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLATFORM_POSTING_DEFAULTS,
  computeAutoScheduleSlots,
  autoSchedulePosts,
  type AutoScheduleInputRow,
} from '../backend/marketing/auto-schedule';

// All tests inject a frozen `now` so the time math is deterministic regardless
// of when the suite runs. Campaign window is set generously around `now` so
// every recommended weekday can fall inside it unless a test explicitly tries
// to push it outside.

const NOW = new Date('2026-06-01T12:00:00.000Z'); // Monday
const CAMPAIGN_START = new Date('2026-06-01T00:00:00.000Z');
const CAMPAIGN_END = new Date('2026-06-30T23:59:59.000Z');
const TZ_NY = 'America/New_York';

function rowsForPlatform(postId: number, platform: string, day: string | null): AutoScheduleInputRow[] {
  return [{ postId, platform, recommendedDay: day }];
}

// --- Platform defaults: marketing-backed hours --------------------------------

test('PLATFORM_POSTING_DEFAULTS pins Instagram 11:00 and Facebook 13:05 tenant-local', () => {
  // The hours are research-backed (Sprout Social / Later / Hootsuite 2024-25).
  // Pinning them prevents accidental drift during a refactor — if someone
  // wants to change the defaults they have to update this test deliberately.
  assert.equal(PLATFORM_POSTING_DEFAULTS.instagram.hour, 11);
  assert.equal(PLATFORM_POSTING_DEFAULTS.instagram.minute, 0);
  assert.equal(PLATFORM_POSTING_DEFAULTS.instagram.staggerMinutes, 0);

  assert.equal(PLATFORM_POSTING_DEFAULTS.facebook.hour, 13);
  assert.equal(PLATFORM_POSTING_DEFAULTS.facebook.minute, 0);
  // Facebook is offset 5 minutes from Instagram to avoid duplicate-minute
  // burst posting flagged by Meta's spam heuristics. Effective time = 13:05.
  assert.equal(PLATFORM_POSTING_DEFAULTS.facebook.staggerMinutes, 5);
});

// --- Per-platform timing ------------------------------------------------------

test('Instagram post on Monday lands at 11:00 tenant-local', () => {
  const result = computeAutoScheduleSlots({
    rows: rowsForPlatform(1, 'instagram', 'Monday'),
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 1);
  const slot = result.slots[0]!;
  assert.equal(slot.appliedDay, 'Monday');
  // 11:00 in America/New_York on a Monday in June 2026 is 15:00 UTC (DST in effect).
  assert.match(slot.scheduledFor.toISOString(), /T15:00:00\.000Z$/);
});

test('Facebook post on Monday lands at 13:05 tenant-local (staggered from Instagram)', () => {
  const result = computeAutoScheduleSlots({
    rows: rowsForPlatform(2, 'facebook', 'Monday'),
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 1);
  const slot = result.slots[0]!;
  // 13:05 ET in June 2026 (DST) = 17:05 UTC.
  assert.match(slot.scheduledFor.toISOString(), /T17:05:00\.000Z$/);
});

test('Instagram + Facebook for the same day are at least 2 hours apart (no duplicate minute)', () => {
  const result = computeAutoScheduleSlots({
    rows: [
      { postId: 1, platform: 'instagram', recommendedDay: 'Tuesday' },
      { postId: 2, platform: 'facebook', recommendedDay: 'Tuesday' },
    ],
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 2);
  const igTime = result.slots[0]!.scheduledFor.getTime();
  const fbTime = result.slots[1]!.scheduledFor.getTime();
  const deltaMinutes = Math.abs(fbTime - igTime) / 60000;
  assert.ok(deltaMinutes >= 120, `expected >= 2h gap, got ${deltaMinutes} minutes`);
});

// --- Per-day routing ---------------------------------------------------------

test('Different recommended days land on different actual calendar dates', () => {
  const result = computeAutoScheduleSlots({
    rows: [
      { postId: 1, platform: 'instagram', recommendedDay: 'Tuesday' },
      { postId: 2, platform: 'instagram', recommendedDay: 'Thursday' },
    ],
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 2);
  const dayParts = (d: Date) => d.toISOString().slice(0, 10);
  // Tuesday June 2, Thursday June 4 in the campaign window.
  assert.equal(dayParts(result.slots[0]!.scheduledFor), '2026-06-02');
  assert.equal(dayParts(result.slots[1]!.scheduledFor), '2026-06-04');
});

test('Recommended day already passed in current week falls forward to next occurrence', () => {
  // now = Monday June 1. recommendedDay = "Sunday" (yesterday).
  // Must NOT pick yesterday; should land on Sunday June 7.
  const result = computeAutoScheduleSlots({
    rows: rowsForPlatform(1, 'instagram', 'Sunday'),
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0]!.scheduledFor.toISOString().slice(0, 10), '2026-06-07');
});

test('Missing recommended_day falls back to first available day, NOT skipped', () => {
  const result = computeAutoScheduleSlots({
    rows: rowsForPlatform(1, 'instagram', null),
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 1);
  assert.match(result.slots[0]!.appliedDay, /^fallback:/);
});

// --- Per-timezone correctness ------------------------------------------------

test('Tenant timezone Tokyo: 11:00 local is 02:00 UTC (not 11:00 UTC)', () => {
  const result = computeAutoScheduleSlots({
    rows: rowsForPlatform(1, 'instagram', 'Monday'),
    tenantTimezone: 'Asia/Tokyo',
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 1);
  // 11:00 JST = 02:00 UTC. The whole point of timezone handling is this assertion.
  assert.match(result.slots[0]!.scheduledFor.toISOString(), /T02:00:00\.000Z$/);
});

test('Null tenant timezone falls back to America/New_York', () => {
  const tzNull = computeAutoScheduleSlots({
    rows: rowsForPlatform(1, 'instagram', 'Monday'),
    tenantTimezone: null,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  const tzExplicit = computeAutoScheduleSlots({
    rows: rowsForPlatform(2, 'instagram', 'Monday'),
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(
    tzNull.slots[0]!.scheduledFor.toISOString(),
    tzExplicit.slots[0]!.scheduledFor.toISOString(),
    'null tz must match America/New_York behavior',
  );
});

// --- Campaign window enforcement --------------------------------------------

test('Schedule never lands before "now" (no past timestamps)', () => {
  const result = computeAutoScheduleSlots({
    rows: rowsForPlatform(1, 'instagram', 'Monday'),
    tenantTimezone: TZ_NY,
    campaignStart: new Date('2026-05-01T00:00:00.000Z'), // start was a month ago
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 1);
  assert.ok(result.slots[0]!.scheduledFor >= NOW, 'derived timestamp must be >= now');
});

test('Schedule never lands after campaign_end', () => {
  const shortEnd = new Date('2026-06-03T23:59:59.000Z');
  const result = computeAutoScheduleSlots({
    rows: rowsForPlatform(1, 'instagram', 'Tuesday'),
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: shortEnd,
    now: NOW,
  });
  for (const slot of result.slots) {
    assert.ok(slot.scheduledFor <= shortEnd, `slot ${slot.scheduledFor.toISOString()} > end ${shortEnd.toISOString()}`);
  }
});

test('Recommended weekday absent from a very short window falls back, NOT skipped', () => {
  // Campaign window is Monday-Tuesday only. Post wants Sunday → no Sunday in
  // window. Helper must fall back to a day inside the window, not skip.
  const monToTue = new Date('2026-06-02T23:59:59.000Z');
  const result = computeAutoScheduleSlots({
    rows: rowsForPlatform(1, 'instagram', 'Sunday'),
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: monToTue,
    now: NOW,
  });
  assert.equal(result.slots.length, 1);
  assert.match(result.slots[0]!.appliedDay, /^fallback:/);
});

test('Closed-or-empty campaign window returns all rows as skipped', () => {
  const result = computeAutoScheduleSlots({
    rows: rowsForPlatform(1, 'instagram', 'Monday'),
    tenantTimezone: TZ_NY,
    campaignStart: new Date('2026-05-01T00:00:00.000Z'),
    campaignEnd: new Date('2026-05-15T00:00:00.000Z'), // closed before NOW
    now: NOW,
  });
  assert.equal(result.slots.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.reason, 'campaign_window_closed_or_empty');
});

// --- Unsupported platform handling -------------------------------------------

test('Unsupported platform is skipped with a typed reason, NOT silently dropped', () => {
  const result = computeAutoScheduleSlots({
    rows: [
      { postId: 1, platform: 'linkedin', recommendedDay: 'Monday' },
      { postId: 2, platform: 'instagram', recommendedDay: 'Monday' },
    ],
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 1, 'instagram must still schedule');
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.reason, /^unsupported_platform:linkedin$/);
});

// --- DB writer (in-memory queryable stub) ------------------------------------

test('autoSchedulePosts upserts every computed slot via the queryable', async () => {
  const upsertedRows: unknown[][] = [];
  const fakeQueryable = {
    async query(_sql: string, params?: unknown[]) {
      upsertedRows.push(params ?? []);
      return {
        rows: [
          {
            id: 999,
            post_id: params?.[0] ?? 0,
            tenant_id: params?.[1] ?? 0,
            scheduled_for: params?.[2] ?? '2026-06-01T00:00:00.000Z',
            target_platforms: params?.[3] ?? [],
            updated_at: '2026-06-01T00:00:00.000Z',
          },
        ],
        rowCount: 1,
      };
    },
  };

  const result = await autoSchedulePosts({
    jobId: 'mkt_test',
    tenantId: 15,
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    rows: [
      { postId: 100, platform: 'instagram', recommendedDay: 'Tuesday' },
      { postId: 101, platform: 'facebook', recommendedDay: 'Tuesday' },
    ],
    queryable: fakeQueryable as never,
    now: NOW,
  });

  assert.equal(result.scheduled, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(upsertedRows.length, 2);
  // Each upsert receives the right post_id + tenant_id + a single-element platforms array.
  assert.equal(upsertedRows[0]![0], 100);
  assert.equal(upsertedRows[0]![1], 15);
  assert.deepEqual(upsertedRows[0]![3], ['instagram']);
  assert.equal(upsertedRows[1]![0], 101);
  assert.deepEqual(upsertedRows[1]![3], ['facebook']);
});

test('autoSchedulePosts: per-row upsert failures are collected, do not stop siblings', async () => {
  let callCount = 0;
  const fakeQueryable = {
    async query(_sql: string, params?: unknown[]) {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('simulated DB error on first upsert');
      }
      return {
        rows: [
          {
            id: 999,
            post_id: params?.[0] ?? 0,
            tenant_id: params?.[1] ?? 0,
            scheduled_for: params?.[2] ?? '',
            target_platforms: params?.[3] ?? [],
            updated_at: '2026-06-01T00:00:00.000Z',
          },
        ],
        rowCount: 1,
      };
    },
  };

  const result = await autoSchedulePosts({
    jobId: 'mkt_test_errors',
    tenantId: 15,
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    rows: [
      { postId: 200, platform: 'instagram', recommendedDay: 'Monday' },
      { postId: 201, platform: 'instagram', recommendedDay: 'Tuesday' },
    ],
    queryable: fakeQueryable as never,
    now: NOW,
  });

  assert.equal(result.scheduled, 1, 'second row must still succeed after first throws');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.postId, 200);
  assert.match(result.errors[0]!.message, /simulated DB error/);
});
