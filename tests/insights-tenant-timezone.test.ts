import assert from 'node:assert/strict';
import test from 'node:test';

import {
  tenantZonePeriodStart,
  tenantZonePeriodStartDateKey,
} from '../lib/format-timestamp';

// S2-3 / AA-94 — the read-side timezone helpers attribute a boundary instant to
// the TENANT's calendar day, not UTC. This is the arithmetic every insights
// builder now shares so all sections agree on which day/hour an event fell on.
//
// Anchor instant: 2026-07-08T03:30:00Z. In America/New_York (UTC-4 in July DST)
// that is 2026-07-07 23:30 — i.e. still "yesterday" for the tenant while UTC has
// already ticked over to the 8th. The classic 23:30-local boundary case.
const NOW = new Date('2026-07-08T03:30:00Z');
const NY = 'America/New_York';

test('tenantZonePeriodStartDateKey attributes a boundary instant to the tenant day, not UTC', () => {
  // days=0 → the tenant's current calendar day. NY sees 2026-07-07; UTC sees 07-08.
  assert.equal(tenantZonePeriodStartDateKey(0, NY, NOW), '2026-07-07');

  // days=7 → 7 tenant-days back from 07-07 = 06-30. A UTC computation from 07-08
  // would land on 07-01, so the tenant-tz window boundary genuinely differs.
  assert.equal(tenantZonePeriodStartDateKey(7, NY, NOW), '2026-06-30');
});

test('tenantZonePeriodStart returns the UTC instant of tenant-zone midnight', () => {
  // Midnight 2026-07-07 in America/New_York (EDT, UTC-4) = 2026-07-07T04:00:00Z.
  assert.equal(tenantZonePeriodStart(0, NY, NOW).toISOString(), '2026-07-07T04:00:00.000Z');
});

test('an event in the window-boundary gap is IN-window under tenant-tz but excluded under the old UTC window', () => {
  // The two 7-day lower bounds differ:
  //   tenant-tz:  midnight 06-30 NY   = 2026-06-30T04:00:00Z
  //   old UTC:    setUTCHours(0,0,0,0) on NOW(07-08) minus 7 days = 2026-07-01T00:00:00Z
  const tenantWindowStart = tenantZonePeriodStart(7, NY, NOW);
  assert.equal(tenantWindowStart.toISOString(), '2026-06-30T04:00:00.000Z');
  const oldUtcWindowStart = new Date('2026-07-01T00:00:00Z'); // what the pre-S2-3 code produced

  // An event at 2026-06-30 08:00 NY (= 2026-06-30T12:00:00Z) falls in the gap:
  // included by the tenant-tz window, excluded by the old UTC window.
  const event = new Date('2026-06-30T12:00:00Z');
  assert.ok(event.getTime() >= tenantWindowStart.getTime(), 'included by tenant-tz window');
  assert.ok(event.getTime() <  oldUtcWindowStart.getTime(), 'excluded by the old UTC window');
});

test('a different tenant zone shifts the boundary independently', () => {
  // Same instant, Chicago (CDT, UTC-5) = 2026-07-07 22:30 → still the 7th, and
  // midnight is 2026-07-07T05:00:00Z. Confirms the helper is per-tenant, not fixed.
  assert.equal(tenantZonePeriodStartDateKey(0, 'America/Chicago', NOW), '2026-07-07');
  assert.equal(tenantZonePeriodStart(0, 'America/Chicago', NOW).toISOString(), '2026-07-07T05:00:00.000Z');
});

test('DST-safe: a period boundary landing on a spring-forward / fall-back day resolves at midnight', () => {
  // The helper always anchors at 00:00 wall-time, which is NEVER inside a DST gap
  // (spring gap is 02:00–03:00) or ambiguous window (fall 01:00–02:00), so
  // fromZonedTime resolves it to exactly one instant. This is independent of the
  // known wallTimeToUtc fall-back bug (a different function, at 01:30, not touched).

  // US spring-forward is 2026-03-08 (02:00→03:00). Midnight 03-08 is still EST
  // (UTC-5) → 2026-03-08T05:00:00Z.
  const springNow = new Date('2026-03-08T12:00:00Z'); // NY civil date = 03-08
  assert.equal(tenantZonePeriodStartDateKey(0, NY, springNow), '2026-03-08');
  assert.equal(tenantZonePeriodStart(0, NY, springNow).toISOString(), '2026-03-08T05:00:00.000Z');

  // US fall-back is 2026-11-01 (02:00→01:00). Midnight 11-01 is still EDT (UTC-4)
  // → 2026-11-01T04:00:00Z.
  const fallNow = new Date('2026-11-01T12:00:00Z'); // NY civil date = 11-01
  assert.equal(tenantZonePeriodStartDateKey(0, NY, fallNow), '2026-11-01');
  assert.equal(tenantZonePeriodStart(0, NY, fallNow).toISOString(), '2026-11-01T04:00:00.000Z');
});

test('invalid/unset zone falls back to the single default (America/New_York)', () => {
  // Fallback path: an unset tenant zone resolves to the default, never throws.
  assert.equal(
    tenantZonePeriodStartDateKey(0, undefined, NOW),
    tenantZonePeriodStartDateKey(0, NY, NOW),
  );
  assert.equal(
    tenantZonePeriodStartDateKey(0, 'Not/AZone', NOW),
    tenantZonePeriodStartDateKey(0, NY, NOW),
  );
});
