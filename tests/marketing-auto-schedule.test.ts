import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLATFORM_POSTING_DEFAULTS,
  computeAutoScheduleSlots,
  computeDefaultCadenceSlots,
  autoSchedulePosts,
  type AutoScheduleInputRow,
} from '../backend/marketing/auto-schedule';
import {
  readWeeklySchedule,
  buildAutoScheduleRows,
  type AutoSchedulePostRow,
} from '../backend/marketing/hermes-callbacks';

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
  assert.equal(PLATFORM_POSTING_DEFAULTS.instagram.feed.hour, 11);
  assert.equal(PLATFORM_POSTING_DEFAULTS.instagram.feed.minute, 0);
  assert.equal(PLATFORM_POSTING_DEFAULTS.instagram.feed.staggerMinutes, 0);

  assert.equal(PLATFORM_POSTING_DEFAULTS.facebook.feed.hour, 13);
  assert.equal(PLATFORM_POSTING_DEFAULTS.facebook.feed.minute, 0);
  // Facebook is offset 5 minutes from Instagram to avoid duplicate-minute
  // burst posting flagged by Meta's spam heuristics. Effective time = 13:05.
  assert.equal(PLATFORM_POSTING_DEFAULTS.facebook.feed.staggerMinutes, 5);
});

// --- Cross-post delivery regression -------------------------------------------
// Weekly cross-post (ARIES_WEEKLY_CROSSPOST_ENABLED) synthesizes x/linkedin/
// reddit `posts` rows, but the scheduler had posting defaults for FB/IG only —
// so those rows were dropped as `unsupported_platform` and NEVER published
// (found by live verification). Both scheduling paths (weekly-schedule and the
// default-cadence path one-off campaigns use) must now schedule them.

for (const platform of ['x', 'linkedin', 'reddit'] as const) {
  test(`crosspost: ${platform} has a feed posting default`, () => {
    assert.ok(PLATFORM_POSTING_DEFAULTS[platform]?.feed, `${platform} needs a feed window`);
    assert.equal(typeof PLATFORM_POSTING_DEFAULTS[platform].feed.hour, 'number');
  });

  test(`crosspost: computeAutoScheduleSlots schedules a ${platform} row (not unsupported_platform)`, () => {
    const result = computeAutoScheduleSlots({
      rows: rowsForPlatform(1, platform, 'Monday'),
      tenantTimezone: TZ_NY,
      campaignStart: CAMPAIGN_START,
      campaignEnd: CAMPAIGN_END,
      now: NOW,
    });
    assert.equal(result.skipped.length, 0, `skipped: ${JSON.stringify(result.skipped)}`);
    assert.equal(result.slots.length, 1);
    assert.equal(result.slots[0].platform, platform);
  });

  test(`crosspost: computeDefaultCadenceSlots (one-off path) schedules a ${platform} row`, () => {
    const result = computeDefaultCadenceSlots({
      rows: [{ postId: 1, platform, ordinal: 1 }],
      tenantTimezone: TZ_NY,
      campaignStart: CAMPAIGN_START,
      campaignEnd: CAMPAIGN_END,
      now: NOW,
    });
    assert.equal(result.skipped.length, 0, `skipped: ${JSON.stringify(result.skipped)}`);
    assert.equal(result.slots.length, 1);
    assert.equal(result.slots[0].platform, platform);
  });
}

// --- Default-cadence per-row roll-forward -------------------------------------
// The default-cadence scheduler decided its "+1 day" advance from a global
// pre-scan of only the MINIMUM ordinal-1 slot, then materialized each row at ITS
// OWN platform hour. When `now`/windowStart fell BETWEEN two platform hours, the
// later-hour platforms whose hour was already past were dropped as
// `derived_timestamp_outside_window` (live: a ~19:55Z run scheduled only
// facebook+reddit and dropped linkedin/instagram/x). The fix rolls each past-hour
// row forward one day on its own; earlier-hour rows that can still post today stay.

test('default-cadence: run past ALL platform hours schedules every platform (no drop)', () => {
  // 2026-07-06 is EDT (UTC-4). Local feed hours in UTC on that day:
  //   linkedin 9:30→13:30Z, instagram 11:00→15:00Z, x 12:30→16:30Z,
  //   facebook 13:05→17:05Z, reddit 14:30→18:30Z.
  // With now at 19:55Z, ALL five have already passed → every row must roll
  // forward exactly one day, and none may be dropped.
  const now = new Date('2026-07-06T19:55:00.000Z');
  const campaignStart = new Date('2026-07-06T19:58:00.000Z'); // a few min in the future
  const campaignEnd = new Date('2026-07-13T19:58:00.000Z'); // +7d
  const platforms = ['facebook', 'instagram', 'x', 'linkedin', 'reddit'] as const;

  const result = computeDefaultCadenceSlots({
    rows: platforms.map((platform, i) => ({ postId: i + 1, platform, ordinal: 1 })),
    tenantTimezone: TZ_NY,
    campaignStart,
    campaignEnd,
    now,
  });

  assert.equal(result.skipped.length, 0, `skipped: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.slots.length, 5, 'all five platforms must be scheduled');
  for (const platform of platforms) {
    assert.ok(
      result.slots.some((s) => s.platform === platform),
      `platform ${platform} must be present (was silently dropped before the fix)`,
    );
  }
  // Every rolled slot lands the next day and inside the window.
  for (const slot of result.slots) {
    assert.ok(slot.scheduledFor >= campaignStart, `${slot.platform} must be >= campaignStart`);
    assert.ok(slot.scheduledFor <= campaignEnd, `${slot.platform} must be <= campaignEnd`);
    // Rolled to 2026-07-07 (all July-6 platform hours were in the past).
    assert.equal(
      slot.scheduledFor.toISOString().slice(0, 10),
      '2026-07-07',
      `${slot.platform} must roll forward one day to 2026-07-07`,
    );
  }
});

test('default-cadence: run BEFORE all platform hours keeps every platform on the same day (no over-advance)', () => {
  // now at 09:00Z (05:00 EDT) is before EVERY platform's local hour on 2026-07-06,
  // so no row should be advanced — all land the SAME day, hour ordering preserved.
  const now = new Date('2026-07-06T09:00:00.000Z');
  const campaignStart = new Date('2026-07-06T00:00:00.000Z');
  const campaignEnd = new Date('2026-07-13T23:59:59.000Z');
  const platforms = ['facebook', 'instagram', 'x', 'linkedin', 'reddit'] as const;

  const result = computeDefaultCadenceSlots({
    rows: platforms.map((platform, i) => ({ postId: i + 1, platform, ordinal: 1 })),
    tenantTimezone: TZ_NY,
    campaignStart,
    campaignEnd,
    now,
  });

  assert.equal(result.skipped.length, 0, `skipped: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.slots.length, 5);
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);
  for (const slot of result.slots) {
    // No over-advancing: each slot stays on 2026-07-06 and is < 24h from now.
    assert.equal(dayOf(slot.scheduledFor), '2026-07-06', `${slot.platform} must stay on today (no over-advance)`);
    assert.ok(
      slot.scheduledFor.getTime() - now.getTime() < 24 * 60 * 60 * 1000,
      `${slot.platform} must be < 24h from now`,
    );
  }
  // Per-platform hour ordering preserved: linkedin(9:30) < instagram(11:00) <
  // x(12:30) < facebook(13:05) < reddit(14:30).
  const byPlatform = new Map(result.slots.map((s) => [s.platform, s.scheduledFor.getTime()]));
  assert.ok((byPlatform.get('linkedin') ?? 0) < (byPlatform.get('instagram') ?? 0), 'linkedin before instagram');
  assert.ok((byPlatform.get('instagram') ?? 0) < (byPlatform.get('x') ?? 0), 'instagram before x');
  assert.ok((byPlatform.get('x') ?? 0) < (byPlatform.get('facebook') ?? 0), 'x before facebook');
  assert.ok((byPlatform.get('facebook') ?? 0) < (byPlatform.get('reddit') ?? 0), 'facebook before reddit');
});

test('default-cadence: a high-ordinal row beyond campaignEnd still skips with overflow_beyond_window', () => {
  // ordinal 30 → baseDate + 29 days, well beyond a 7-day window → overflow skip.
  const now = new Date('2026-07-06T09:00:00.000Z');
  const campaignStart = new Date('2026-07-06T00:00:00.000Z');
  const campaignEnd = new Date('2026-07-13T23:59:59.000Z');

  const result = computeDefaultCadenceSlots({
    rows: [{ postId: 1, platform: 'instagram', ordinal: 30 }],
    tenantTimezone: TZ_NY,
    campaignStart,
    campaignEnd,
    now,
  });

  assert.equal(result.slots.length, 0, 'the overflowing row must not be scheduled');
  assert.equal(result.skipped.length, 1);
  assert.match(
    result.skipped[0].reason,
    /^overflow_beyond_window:30$/,
    `expected overflow_beyond_window:30, got ${result.skipped[0].reason}`,
  );
});

test('default-cadence: multi-ordinal run past all hours keeps the one-per-day ladder (no same-instant collision)', () => {
  // The roll-forward must shift EVERY ordinal of a (platform, surface) pair
  // together. A per-row roll would advance only ordinal 1 (its slot passed) and
  // leave ordinal 2 (tomorrow, still future) where it is — landing both on the
  // SAME instant and double-booking the platform on day 1.
  const now = new Date('2026-07-06T19:55:00.000Z'); // past all five platform hours
  const campaignStart = new Date('2026-07-06T19:58:00.000Z');
  const campaignEnd = new Date('2026-07-16T19:58:00.000Z'); // +10d
  const platforms = ['facebook', 'instagram', 'x', 'linkedin', 'reddit'] as const;
  const ordinals = [1, 2, 3] as const;

  const result = computeDefaultCadenceSlots({
    rows: platforms.flatMap((platform, p) =>
      ordinals.map((ordinal) => ({ postId: p * 10 + ordinal, platform, ordinal })),
    ),
    tenantTimezone: TZ_NY,
    campaignStart,
    campaignEnd,
    now,
  });

  assert.equal(result.skipped.length, 0, `skipped: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.slots.length, platforms.length * ordinals.length);
  for (const platform of platforms) {
    const times = result.slots
      .filter((s) => s.platform === platform)
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
      .map((s) => s.scheduledFor);
    assert.equal(times.length, ordinals.length, `${platform} must schedule every ordinal`);
    assert.equal(
      new Set(times.map((t) => t.getTime())).size,
      ordinals.length,
      `${platform} ordinals must not collide on the same instant`,
    );
    // All ordinals shifted together: day 1, 2, 3 (2026-07-07..09), exactly 24h apart.
    for (let i = 0; i < times.length; i += 1) {
      assert.equal(
        times[i].toISOString().slice(0, 10),
        `2026-07-0${7 + i}`,
        `${platform} ordinal ${i + 1} must land on day ${i + 1} of the shifted ladder`,
      );
    }
  }
});

test('default-cadence: run BETWEEN platform hours shifts only past-hour pairs, whole ladder per pair', () => {
  // 15:30Z on 2026-07-06 is 11:30 EDT: linkedin(9:30) + instagram(11:00) have
  // passed → their whole ladders shift +1 day; x(12:30)/facebook(13:05)/
  // reddit(14:30) are still ahead → their ladders stay. Nothing is dropped
  // (the live bug), and no pair double-books a day (the per-row-roll bug).
  const now = new Date('2026-07-06T15:30:00.000Z');
  const campaignStart = new Date('2026-07-06T00:00:00.000Z');
  const campaignEnd = new Date('2026-07-16T23:59:59.000Z');
  const platforms = ['facebook', 'instagram', 'x', 'linkedin', 'reddit'] as const;
  const ordinals = [1, 2] as const;

  const result = computeDefaultCadenceSlots({
    rows: platforms.flatMap((platform, p) =>
      ordinals.map((ordinal) => ({ postId: p * 10 + ordinal, platform, ordinal })),
    ),
    tenantTimezone: TZ_NY,
    campaignStart,
    campaignEnd,
    now,
  });

  assert.equal(result.skipped.length, 0, `skipped: ${JSON.stringify(result.skipped)}`);
  assert.equal(result.slots.length, platforms.length * ordinals.length);
  const firstDay = (platform: string) =>
    result.slots
      .filter((s) => s.platform === platform)
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0]
      .scheduledFor.toISOString()
      .slice(0, 10);
  // Past-hour pairs start tomorrow; still-ahead pairs start today.
  assert.equal(firstDay('linkedin'), '2026-07-07', 'linkedin (9:30, passed) starts tomorrow');
  assert.equal(firstDay('instagram'), '2026-07-07', 'instagram (11:00, passed) starts tomorrow');
  assert.equal(firstDay('x'), '2026-07-06', 'x (12:30, ahead) stays today');
  assert.equal(firstDay('facebook'), '2026-07-06', 'facebook (13:05, ahead) stays today');
  assert.equal(firstDay('reddit'), '2026-07-06', 'reddit (14:30, ahead) stays today');
  // Every pair keeps one-per-day spacing with no collisions.
  for (const platform of platforms) {
    const times = result.slots
      .filter((s) => s.platform === platform)
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
      .map((s) => s.scheduledFor.getTime());
    assert.equal(new Set(times).size, times.length, `${platform} must not double-book an instant`);
    assert.equal(times[1] - times[0], 24 * 60 * 60 * 1000, `${platform} ordinals must sit exactly one day apart`);
  }
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
      // pinterest is not an Aries publish target (no posting defaults) — a truly
      // unsupported platform. (linkedin/x/reddit are now supported crosspost
      // targets and would schedule.)
      { postId: 1, platform: 'pinterest', recommendedDay: 'Monday' },
      { postId: 2, platform: 'instagram', recommendedDay: 'Monday' },
    ],
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 1, 'instagram must still schedule');
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.reason, /^unsupported_platform:pinterest$/);
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

// --- Regression: uneven platform fan-out -------------------------------------
//
// Copilot caught a critical bug in the earlier iteration: if a content_package
// has uneven platform fan-out (post 1 → [IG, FB], post 2 → [IG only]), the
// row-index-based ordinal `1 + Math.floor(idx/2)` mis-assigns the second IG
// row to weekly_schedule entry 1, stealing its `recommended_day`. The fix
// uses `posts.idempotency_key` (which encodes post_number) for the mapping.
// This test exercises the helper directly via the public input shape so any
// future refactor that drops the key-based mapping fails loudly.

test('uneven platform fan-out keeps each post mapped to its own recommended_day', () => {
  // post 1 wants Tuesday on both platforms.
  // post 2 wants Thursday on Instagram only.
  // If we accidentally fell back to row-index ordinal math, the second
  // Instagram row (post 2) would be mapped to ordinal 1 (post 1's Tuesday).
  const result = computeAutoScheduleSlots({
    rows: [
      { postId: 100, platform: 'instagram', recommendedDay: 'Tuesday' }, // post 1 IG
      { postId: 101, platform: 'facebook', recommendedDay: 'Tuesday' },  // post 1 FB
      { postId: 102, platform: 'instagram', recommendedDay: 'Thursday' }, // post 2 IG (NOT Tuesday)
    ],
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 3);
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);
  assert.equal(dayOf(result.slots[0]!.scheduledFor), '2026-06-02', 'post 1 IG → Tuesday');
  assert.equal(dayOf(result.slots[1]!.scheduledFor), '2026-06-02', 'post 1 FB → Tuesday');
  assert.equal(dayOf(result.slots[2]!.scheduledFor), '2026-06-04', 'post 2 IG → Thursday, NOT Tuesday');
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

// --- readWeeklySchedule: Hermes wire-shape field-name regression ---------------------------
//
// v0.1.12.13 read `primary_output.weekly_schedule` and `entry.platform_targets[].platform`
// but the actual Hermes wire payload uses `primary_output.schedule` and `entry.platforms`
// (flat strings). Both shapes must parse to the same recommended_day map.

function makeMinimalDoc(primaryOutput: Record<string, unknown>) {
  return {
    schema_name: 'marketing_job_state_schema' as const,
    schema_version: '1.0.0' as const,
    job_id: 'mkt_test',
    tenant_id: '15',
    job_type: 'one_off_campaign' as const,
    state: 'active' as const,
    status: 'running' as const,
    current_stage: 'publish' as const,
    stage_order: ['publish' as const],
    stages: {
      publish: { primary_output: primaryOutput },
    } as never,
    approvals: { current: null, history: [] },
    publish_config: {} as never,
    brand_kit: null,
    inputs: { request: {}, brand_url: '' },
    created_at: '2026-05-27T00:00:00.000Z',
    updated_at: '2026-05-27T00:00:00.000Z',
    error: null,
  };
}

test('readWeeklySchedule reads current Hermes wire shape: schedule[] + platforms[] flat strings', () => {
  const doc = makeMinimalDoc({
    schedule: [
      { post_number: 1, recommended_day: 'Monday', platforms: ['instagram', 'facebook'] },
      { post_number: 2, recommended_day: 'Wednesday', platforms: ['instagram'] },
    ],
  });
  const entries = readWeeklySchedule(doc as never);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.recommended_day, 'Monday');
  assert.deepEqual(entries[0]!.platforms, ['instagram', 'facebook']);
  assert.equal(entries[1]!.recommended_day, 'Wednesday');
  assert.deepEqual(entries[1]!.platforms, ['instagram']);
});

test('readWeeklySchedule falls back to legacy weekly_schedule[] + platform_targets[] shape', () => {
  const doc = makeMinimalDoc({
    weekly_schedule: [
      {
        post_number: 1,
        recommended_day: 'Tuesday',
        platform_targets: [{ platform: 'instagram' }, { platform: 'facebook' }],
      },
    ],
  });
  const entries = readWeeklySchedule(doc as never);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.recommended_day, 'Tuesday');
  assert.deepEqual(entries[0]!.platform_targets, [
    { platform: 'instagram' },
    { platform: 'facebook' },
  ]);
});

test('readWeeklySchedule: schedule[] takes precedence over weekly_schedule[] when both present', () => {
  const doc = makeMinimalDoc({
    schedule: [{ post_number: 1, recommended_day: 'Friday', platforms: ['instagram'] }],
    weekly_schedule: [{ post_number: 1, recommended_day: 'Monday', platform_targets: [] }],
  });
  const entries = readWeeklySchedule(doc as never);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.recommended_day, 'Friday', 'schedule[] must win over weekly_schedule[]');
});

test('readWeeklySchedule returns [] when publish stage has no schedule output', () => {
  const doc = makeMinimalDoc({});
  const entries = readWeeklySchedule(doc as never);
  assert.equal(entries.length, 0);
});

// --- Surface dimension (feed / story / reel) ---------------------------------

test('computeAutoScheduleSlots picks per-surface slots and carries surface/mediaType', () => {
  const rows: AutoScheduleInputRow[] = [
    { postId: 1, platform: 'instagram', recommendedDay: 'Monday', surface: 'feed', mediaType: 'image' },
    { postId: 2, platform: 'instagram', recommendedDay: 'Monday', surface: 'reel', mediaType: 'video' },
    { postId: 3, platform: 'instagram', recommendedDay: 'Monday', surface: 'story', mediaType: 'video' },
  ];
  const { slots } = computeAutoScheduleSlots({
    rows,
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(slots.length, 3);
  const bySurface = new Map(slots.map((s) => [s.surface, s]));
  assert.equal(bySurface.get('feed')?.mediaType, 'image');
  assert.equal(bySurface.get('reel')?.mediaType, 'video');
  assert.equal(bySurface.get('story')?.mediaType, 'video');
  // Reel slot hour differs from feed slot hour (distinct per-surface window).
  assert.notEqual(bySurface.get('feed')?.appliedWallTime, bySurface.get('reel')?.appliedWallTime);
});

test('PLATFORM_POSTING_DEFAULTS nests by surface for both platforms', () => {
  assert.equal(typeof PLATFORM_POSTING_DEFAULTS.instagram.reel.hour, 'number');
  assert.equal(typeof PLATFORM_POSTING_DEFAULTS.instagram.story.hour, 'number');
  assert.equal(typeof PLATFORM_POSTING_DEFAULTS.facebook.reel.hour, 'number');
  assert.equal(typeof PLATFORM_POSTING_DEFAULTS.facebook.story.hour, 'number');
});

test('absent surface/mediaType defaults to feed/image', () => {
  const rows: AutoScheduleInputRow[] = [
    { postId: 9, platform: 'facebook', recommendedDay: 'Tuesday' },
  ];
  const { slots } = computeAutoScheduleSlots({
    rows,
    tenantTimezone: TZ_NY,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(slots[0]?.surface, 'feed');
  assert.equal(slots[0]?.mediaType, 'image');
});

// --- buildAutoScheduleRows: surface comes from the POST, not the schedule ----
// Regression for the auto-promotion surface-drop: an auto-promoted image story
// (posts.surface='story', idempotency `<job>:1:instagram:story`) shares ordinal 1
// with its feed sibling, and the strategist weekly_schedule emits NO story
// placement. The row builder must take surface/media_type from the post's own
// columns so the story is scheduled as a story — not collapsed onto the feed
// entry and published to the feed.
const STORY_JOB = 'mkt_story_promotion';
const WEEKLY_FEED_ONLY = [
  { post_number: 1, recommended_day: 'Wednesday', platforms: ['instagram', 'facebook'] },
];

test('buildAutoScheduleRows: promoted story post keeps surface=story despite a feed-only schedule', () => {
  const postRows: AutoSchedulePostRow[] = [
    // feed sibling for ordinal 1
    { id: 10, platform: 'instagram', idempotency_key: `${STORY_JOB}:1:instagram:feed`, surface: 'feed', media_type: 'image', width_px: null, height_px: null, duration_seconds: null },
    // auto-promoted image story for the SAME ordinal 1
    { id: 11, platform: 'instagram', idempotency_key: `${STORY_JOB}:1:instagram:story`, surface: 'story', media_type: 'image', width_px: null, height_px: null, duration_seconds: null },
  ];

  const rows = buildAutoScheduleRows(postRows, WEEKLY_FEED_ONLY, STORY_JOB);

  const feed = rows.find((r) => r.postId === 10);
  const story = rows.find((r) => r.postId === 11);
  assert.equal(feed?.surface, 'feed');
  assert.equal(story?.surface, 'story', 'story post must NOT inherit the feed schedule surface');
  // Both still pick up the strategist recommended DAY from the schedule.
  assert.equal(feed?.recommendedDay, 'Wednesday');
  assert.equal(story?.recommendedDay, 'Wednesday');
});

test('buildAutoScheduleRows: media_type also comes from the post (video preserved)', () => {
  const postRows: AutoSchedulePostRow[] = [
    { id: 20, platform: 'facebook', idempotency_key: `${STORY_JOB}:1:facebook:reel`, surface: 'reel', media_type: 'video', width_px: null, height_px: null, duration_seconds: null },
  ];
  const rows = buildAutoScheduleRows(postRows, WEEKLY_FEED_ONLY, STORY_JOB);
  assert.equal(rows[0]?.surface, 'reel');
  assert.equal(rows[0]?.mediaType, 'video');
});

test('buildAutoScheduleRows: null/legacy surface falls back to feed/image', () => {
  const postRows: AutoSchedulePostRow[] = [
    { id: 30, platform: 'instagram', idempotency_key: `${STORY_JOB}:1:instagram:feed`, surface: null, media_type: null, width_px: null, height_px: null, duration_seconds: null },
  ];
  const rows = buildAutoScheduleRows(postRows, WEEKLY_FEED_ONLY, STORY_JOB);
  assert.equal(rows[0]?.surface, 'feed');
  assert.equal(rows[0]?.mediaType, 'image');
});
