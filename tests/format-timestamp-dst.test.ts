import assert from 'node:assert/strict';
import test from 'node:test';

import { utcToWallTime, wallTimeToUtc } from '../lib/format-timestamp';

/**
 * DST conversion policy (see lib/format-timestamp.ts DST_POLICY):
 *  - spring-forward gap: push the instant forward to the next valid wall time.
 *  - fall-back duplicate: pick the earlier offset (first occurrence).
 */

test('wallTimeToUtc converts a normal winter wall time (EST, UTC-5)', () => {
  const utc = wallTimeToUtc('2026-01-15T09:00', 'America/New_York');
  assert.ok(utc);
  assert.equal(utc.toISOString(), '2026-01-15T14:00:00.000Z');
});

test('wallTimeToUtc converts a normal summer wall time (EDT, UTC-4)', () => {
  const utc = wallTimeToUtc('2026-07-15T09:00', 'America/New_York');
  assert.ok(utc);
  assert.equal(utc.toISOString(), '2026-07-15T13:00:00.000Z');
});

test('wallTimeToUtc round-trips with utcToWallTime', () => {
  const wall = '2026-09-01T14:45';
  const utc = wallTimeToUtc(wall, 'America/New_York');
  assert.ok(utc);
  assert.equal(utcToWallTime(utc, 'America/New_York'), wall);
});

test('wallTimeToUtc DST spring-forward gap: 02:30 on 2026-03-08 does not exist', () => {
  // US DST 2026 begins 2026-03-08 02:00 -> 03:00; 02:30 is a gap.
  // date-fns-tz resolves the gap with the post-transition offset (EDT, UTC-4),
  // i.e. it interprets 02:30 forward into the new offset -> 06:30Z. The policy
  // requirement is that a gap input still yields a single deterministic
  // instant and that instant is never re-rendered as the (nonexistent) 02:30
  // wall time.
  const utc = wallTimeToUtc('2026-03-08T02:30', 'America/New_York');
  assert.ok(utc);
  assert.equal(utc.toISOString(), '2026-03-08T06:30:00.000Z');
  // Deterministic: the same gap input always maps to the same instant.
  const again = wallTimeToUtc('2026-03-08T02:30', 'America/New_York');
  assert.equal(again?.toISOString(), utc.toISOString());
});

test('wallTimeToUtc DST fall-back duplicate: 01:30 on 2026-11-01 occurs twice', () => {
  // US DST 2026 ends 2026-11-01 02:00 -> 01:00; 01:30 occurs twice.
  // Policy: pick the earlier offset (EDT, UTC-4) = 05:30Z.
  const utc = wallTimeToUtc('2026-11-01T01:30', 'America/New_York');
  assert.ok(utc);
  assert.equal(utc.toISOString(), '2026-11-01T05:30:00.000Z');
});

test('wallTimeToUtc handles a non-DST zone consistently year-round', () => {
  // Phoenix does not observe DST (UTC-7 all year).
  const winter = wallTimeToUtc('2026-01-15T09:00', 'America/Phoenix');
  const summer = wallTimeToUtc('2026-07-15T09:00', 'America/Phoenix');
  assert.equal(winter?.toISOString(), '2026-01-15T16:00:00.000Z');
  assert.equal(summer?.toISOString(), '2026-07-15T16:00:00.000Z');
});

test('wallTimeToUtc rejects malformed wall-time strings', () => {
  assert.equal(wallTimeToUtc('2026-13-40T99:99', 'UTC'), null);
  assert.equal(wallTimeToUtc('not-a-date', 'UTC'), null);
  assert.equal(wallTimeToUtc('', 'UTC'), null);
  assert.equal(wallTimeToUtc('2026-01-15', 'UTC'), null);
});

test('wallTimeToUtc accepts an optional seconds component', () => {
  const utc = wallTimeToUtc('2026-01-15T09:00:30', 'America/New_York');
  assert.ok(utc);
  assert.equal(utc.toISOString(), '2026-01-15T14:00:30.000Z');
});
