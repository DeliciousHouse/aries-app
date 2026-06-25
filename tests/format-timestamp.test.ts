import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TENANT_TIMEZONE,
  formatInTenantZone,
  formatTenantDateRangeLabel,
  formatTimeInTenantZone,
  isTenantZoneToday,
  isValidTimeZone,
  resolveTenantTimeZone,
  tenantZoneDateKey,
  tenantZoneParts,
  utcToWallTime,
} from '../lib/format-timestamp';

test('isValidTimeZone accepts IANA zones and rejects junk', () => {
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('Europe/London'), true);
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone('America-New_York'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone('   '), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(isValidTimeZone(42), false);
});

test('resolveTenantTimeZone falls back to the fixed default for invalid input', () => {
  assert.equal(resolveTenantTimeZone('Europe/Paris'), 'Europe/Paris');
  assert.equal(resolveTenantTimeZone('garbage'), DEFAULT_TENANT_TIMEZONE);
  assert.equal(resolveTenantTimeZone(undefined), DEFAULT_TENANT_TIMEZONE);
  assert.equal(resolveTenantTimeZone(null), DEFAULT_TENANT_TIMEZONE);
});

test('formatInTenantZone renders a UTC instant in the tenant zone', () => {
  // 2026-01-15T18:30:00Z is 13:30 EST.
  const label = formatInTenantZone('2026-01-15T18:30:00.000Z', 'America/New_York');
  assert.match(label, /Jan 15/);
  assert.match(label, /1:30/);
});

test('formatInTenantZone shifts the calendar day across zones', () => {
  // 2026-01-16T03:00:00Z is still Jan 15, 22:00 EST.
  const label = formatInTenantZone('2026-01-16T03:00:00.000Z', 'America/New_York');
  assert.match(label, /Jan 15/);
});

test('formatInTenantZone returns the raw value for an unparseable input', () => {
  assert.equal(formatInTenantZone('not-a-date', 'UTC'), 'not-a-date');
});

test('formatTimeInTenantZone renders a 24h time in zone', () => {
  // 2026-06-15T20:00:00Z is 16:00 EDT.
  assert.equal(formatTimeInTenantZone('2026-06-15T20:00:00.000Z', 'America/New_York'), '16:00');
});

test('tenantZoneDateKey keys an 11pm-tenant-zone post on the tenant day', () => {
  // 11pm Jan 15 in New York is 2026-01-16T04:00:00Z.
  assert.equal(tenantZoneDateKey('2026-01-16T04:00:00.000Z', 'America/New_York'), '2026-01-15');
  // Same instant in Tokyo is Jan 16.
  assert.equal(tenantZoneDateKey('2026-01-16T04:00:00.000Z', 'Asia/Tokyo'), '2026-01-16');
});

test('isTenantZoneToday compares the civil day in the tenant zone', () => {
  const now = new Date('2026-03-10T12:00:00.000Z');
  assert.equal(isTenantZoneToday('2026-03-10T15:00:00.000Z', 'America/New_York', now), true);
  assert.equal(isTenantZoneToday('2026-03-11T15:00:00.000Z', 'America/New_York', now), false);
});

test('utcToWallTime produces a datetime-local-shaped string', () => {
  // 2026-01-15T18:30:00Z is 13:30 EST.
  assert.equal(utcToWallTime('2026-01-15T18:30:00.000Z', 'America/New_York'), '2026-01-15T13:30');
});

test('tenantZoneParts breaks an instant into civil fields', () => {
  const parts = tenantZoneParts('2026-01-15T18:30:00.000Z', 'America/New_York');
  assert.deepEqual(parts, { year: 2026, month: 1, day: 15, hour: 13, minute: 30 });
});

test('tenantZoneParts normalizes hour 24 to 0 at midnight', () => {
  // Midnight Jan 16 New York is 2026-01-16T05:00:00Z.
  const parts = tenantZoneParts('2026-01-16T05:00:00.000Z', 'America/New_York');
  assert.equal(parts?.hour, 0);
  assert.equal(parts?.day, 16);
});

test('formatTenantDateRangeLabel renders UTC publish windows in the tenant timezone', () => {
  const label = formatTenantDateRangeLabel(
    '2026-06-03T00:00:00.000Z',
    '2026-06-09T23:59:59.999Z',
    'America/New_York',
  );

  assert.equal(label, 'Jun 2, 8:00 PM EDT to Jun 9, 7:59 PM EDT');
  assert.doesNotMatch(label, /2026-06-03T00:00:00\.000Z/);
  assert.doesNotMatch(label, /UTC/);
});

test('formatTenantDateRangeLabel preserves invalid publish window fallback without inventing dates', () => {
  assert.equal(formatTenantDateRangeLabel(null, '2026-06-09T23:59:59.999Z', 'America/New_York'), 'Dates not scheduled yet');
  assert.equal(formatTenantDateRangeLabel('bad-start', 'bad-end', 'America/New_York'), 'bad-start to bad-end');
});
