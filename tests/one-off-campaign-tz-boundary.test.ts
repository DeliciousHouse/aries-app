import assert from 'node:assert/strict';
import test from 'node:test';
import { wallTimeToUtc } from '@/lib/format-timestamp';
import { validateAndConvertOneOffBrief } from '@/app/api/marketing/jobs/handler';

// [CRITICAL]: lock in tenant-local end-of-day semantics for one-off campaigns
// across PT and JST. The worker SQL is timezone-agnostic (NOW() vs a stored
// UTC timestamptz); the timezone behaviour all lives in wallTimeToUtc, which
// validateAndConvertOneOffBrief calls when the submit handler converts the
// form's YYYY-MM-DD dates. A regression here ships posts that publish hours
// early (PT) or hours late (JST) relative to what the operator typed.

test('PT tenant: "ends June 10" → UTC instant on June 11 06:59:59', () => {
  // America/Los_Angeles on June 10 2026 is PDT (UTC-7). End-of-day PT =
  // 23:59:59 PDT = 06:59:59 UTC on June 11. A naive UTC-midnight implementation
  // would stop the campaign at 17:00 PDT on June 9 -- 7 hours early.
  const utc = wallTimeToUtc('2026-06-10T23:59:59', 'America/Los_Angeles');
  assert.ok(utc);
  assert.equal(utc?.toISOString(), '2026-06-11T06:59:59.000Z');
});

test('JST tenant: "ends June 10" → UTC instant on June 10 14:59:59', () => {
  // Asia/Tokyo is UTC+9, no DST. End-of-day JST = 23:59:59 JST = 14:59:59 UTC
  // on June 10 -- the same calendar day in UTC.
  const utc = wallTimeToUtc('2026-06-10T23:59:59', 'Asia/Tokyo');
  assert.ok(utc);
  assert.equal(utc?.toISOString(), '2026-06-10T14:59:59.000Z');
});

test('PT and JST boundaries differ by 16 hours for the same calendar date', () => {
  const pt = wallTimeToUtc('2026-06-10T23:59:59', 'America/Los_Angeles');
  const jst = wallTimeToUtc('2026-06-10T23:59:59', 'Asia/Tokyo');
  assert.ok(pt && jst);
  const diffHours = (pt!.getTime() - jst!.getTime()) / 3_600_000;
  assert.equal(diffHours, 16);
});

test('PT tenant during PST (winter): "ends Jan 15" → UTC instant on Jan 16 07:59:59', () => {
  // January is PST (UTC-8). End-of-day shifts one hour later in UTC.
  const utc = wallTimeToUtc('2026-01-15T23:59:59', 'America/Los_Angeles');
  assert.ok(utc);
  assert.equal(utc?.toISOString(), '2026-01-16T07:59:59.000Z');
});

test('wallTimeToUtc rejects non-YYYY-MM-DDTHH:mm[:ss] shapes', () => {
  assert.equal(wallTimeToUtc('06/10/2026', 'America/Los_Angeles'), null);
  assert.equal(wallTimeToUtc('2026-06-10', 'America/Los_Angeles'), null);
  assert.equal(wallTimeToUtc('not-a-date', 'America/Los_Angeles'), null);
});

test('validateAndConvertOneOffBrief produces NY end-of-day UTC for fallback tenant', () => {
  // No business_profiles row for tenant '999999' → falls back to America/New_York
  // (DEFAULT_TENANT_TIMEZONE). EDT = UTC-4 in June.
  const result = validateAndConvertOneOffBrief({
    name: 'Aries AI Hackathon',
    campaignEndDate: '2026-06-10',
    cta: 'Register',
  }, '999999');
  assert.ok('oneOff' in result);
  if ('oneOff' in result) {
    assert.equal(result.oneOff.campaignEndDate, '2026-06-11T03:59:59.000Z');
  }
});
