import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndConvertOneOffBrief } from '@/app/api/marketing/jobs/handler';
import { loadTenantTimezoneOrFallback } from '@/backend/tenant/business-profile';

// Server-side validation + tz conversion for the one-off campaign brief.
// validateAndConvertOneOffBrief is the boundary where the form's YYYY-MM-DD
// calendar dates become tenant-local end-of-day UTC ISO strings -- once
// converted, downstream (orchestrator, schedule route, worker) only ever sees
// UTC. A bug here ships the wrong publishing window to every non-server-tz
// tenant; this test pins the contract.
//
// The tenantId argument is passed verbatim into loadTenantTimezoneOrFallback,
// which reads business_profiles for that tenant; in a test environment with
// no business profile on disk, the helper falls back to DEFAULT_TENANT_TIMEZONE
// (America/New_York). Tests below assume that fallback.

const FAKE_TENANT_ID = '999999';

const CURRENT_YEAR = new Date().getFullYear();
// The validator rejects past campaignEndDate (measured in tenant-local time),
// so fixture dates must stay in the future forever — a hardcoded calendar year
// rots the suite the day after the date passes (this bit on 2026-06-11). June
// of next year is always EDT (UTC-4) in America/New_York under post-2007 DST
// rules, so the expected end-of-day UTC instants stay deterministic.
const FUTURE_YEAR = CURRENT_YEAR + 1;

test('missing required fields produce a 422-shaped fieldErrors object', () => {
  const result = validateAndConvertOneOffBrief({}, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.name']);
    assert.ok(result.fieldErrors['oneOff.campaignEndDate']);
    assert.ok(result.fieldErrors['oneOff.cta']);
  }
});

test('null/undefined payload yields fieldErrors, not a crash', () => {
  assert.ok('fieldErrors' in validateAndConvertOneOffBrief(null, FAKE_TENANT_ID));
  assert.ok('fieldErrors' in validateAndConvertOneOffBrief(undefined, FAKE_TENANT_ID));
});

test('non-YYYY-MM-DD date format rejected with structured error', () => {
  const result = validateAndConvertOneOffBrief({
    name: 'Summer Flash Sale',
    campaignEndDate: '06/10/2026',
    cta: 'Shop the sale',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.campaignEndDate']);
  }
});

test('milestone date without label is rejected (orphan field)', () => {
  const result = validateAndConvertOneOffBrief({
    name: 'Product launch',
    campaignEndDate: `${FUTURE_YEAR}-06-14`,
    cta: 'Pre-order now',
    milestoneDate: `${FUTURE_YEAR}-06-10`,
    // milestoneLabel missing
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.milestoneLabel']);
  }
});

test('milestone label without date is rejected (orphan field)', () => {
  const result = validateAndConvertOneOffBrief({
    name: 'Product launch',
    campaignEndDate: `${FUTURE_YEAR}-06-14`,
    cta: 'Pre-order now',
    milestoneLabel: 'Launch day',
    // milestoneDate missing
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.milestoneDate']);
  }
});

test('milestone date AFTER campaign end is rejected (incoherent ordering)', () => {
  const result = validateAndConvertOneOffBrief({
    name: 'Webinar',
    campaignEndDate: `${FUTURE_YEAR}-06-10`,
    cta: 'Save your seat',
    milestoneDate: `${FUTURE_YEAR}-06-15`,
    milestoneLabel: 'Doors open',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.milestoneDate']);
  }
});

test('valid minimal payload converts campaignEndDate to NY end-of-day UTC', () => {
  // June 10 of FUTURE_YEAR in EDT (UTC-4). End-of-day NY = 23:59:59 EDT = 03:59:59 UTC on June 11.
  const result = validateAndConvertOneOffBrief({
    name: 'Summer Flash Sale',
    campaignEndDate: `${FUTURE_YEAR}-06-10`,
    cta: 'Shop the sale',
  }, FAKE_TENANT_ID);
  assert.ok('oneOff' in result);
  if ('oneOff' in result) {
    assert.equal(result.oneOff.name, 'Summer Flash Sale');
    assert.equal(result.oneOff.cta, 'Shop the sale');
    assert.equal(result.oneOff.campaignEndDate, `${FUTURE_YEAR}-06-11T03:59:59.000Z`);
    assert.equal(result.oneOff.milestoneDate, undefined);
    assert.equal(result.oneOff.milestoneLabel, undefined);
  }
});

test('valid payload with milestone produces both UTC instants and label', () => {
  const result = validateAndConvertOneOffBrief({
    name: 'Aries AI Hackathon',
    campaignEndDate: `${FUTURE_YEAR}-06-14`,
    cta: 'Register at example.com/hackathon',
    milestoneDate: `${FUTURE_YEAR}-06-10`,
    milestoneLabel: 'Registration deadline',
  }, FAKE_TENANT_ID);
  assert.ok('oneOff' in result);
  if ('oneOff' in result) {
    assert.equal(result.oneOff.campaignEndDate, `${FUTURE_YEAR}-06-15T03:59:59.000Z`);
    assert.equal(result.oneOff.milestoneDate, `${FUTURE_YEAR}-06-11T03:59:59.000Z`);
    assert.equal(result.oneOff.milestoneLabel, 'Registration deadline');
  }
});

test('whitespace-only fields treated as missing', () => {
  const result = validateAndConvertOneOffBrief({
    name: '   ',
    campaignEndDate: `${FUTURE_YEAR}-06-10`,
    cta: '   ',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.name']);
    assert.ok(result.fieldErrors['oneOff.cta']);
  }
});

// --- Date hardening tests (v0.1.11.2) ---
// Year range and past-date guards added after Brendan's QA found that browser
// automation input corruption ("0004-02-06") slipped past the YYYY-MM-DD regex.

// A date far enough in the future to always be valid (next year).
const VALID_NEAR_FUTURE = `${FUTURE_YEAR}-06-15`;

test('past date (yesterday) is rejected with campaignEndDate field error', () => {
  // Derive "yesterday" in the SAME timezone the validator measures "today" in
  // (loadTenantTimezoneOrFallback(FAKE_TENANT_ID) -> the America/New_York
  // fallback). A UTC-derived date flakes daily: between 00:00-04:00 UTC,
  // UTC-yesterday == tenant-today, so the validator correctly treats it as
  // today (allowed) and a naive test fails. Mirroring the validator's tz keeps
  // the exact-yesterday boundary deterministic at any UTC hour.
  const tenantTz = loadTenantTimezoneOrFallback(FAKE_TENANT_ID);
  const todayWall = new Date().toLocaleDateString('en-CA', { timeZone: tenantTz }); // YYYY-MM-DD in tenant tz
  const [yr, mo, dy] = todayWall.split('-').map(Number);
  const yesterday = new Date(Date.UTC(yr, mo - 1, dy));
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const pastDate = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD
  const result = validateAndConvertOneOffBrief({
    name: 'Sale',
    campaignEndDate: pastDate,
    cta: 'Shop now',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.campaignEndDate'],
      'past campaignEndDate must produce a field error');
  }
});

test('ancient year (0004) is rejected with year-range field error', () => {
  const result = validateAndConvertOneOffBrief({
    name: 'Sale',
    campaignEndDate: '0004-02-06',
    cta: 'Shop now',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.campaignEndDate'],
      'year 0004 must be rejected by the year-range guard');
    assert.match(
      result.fieldErrors['oneOff.campaignEndDate'],
      /current or near-future year/,
    );
  }
});

test('far-future year (current + 15) is rejected with year-range field error', () => {
  const farFuture = `${CURRENT_YEAR + 15}-06-15`;
  const result = validateAndConvertOneOffBrief({
    name: 'Sale',
    campaignEndDate: farFuture,
    cta: 'Shop now',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.campaignEndDate'],
      `year ${CURRENT_YEAR + 15} must be rejected by the year-range guard`);
  }
});

test('within-range future date is accepted', () => {
  const result = validateAndConvertOneOffBrief({
    name: 'Summer Flash Sale',
    campaignEndDate: VALID_NEAR_FUTURE,
    cta: 'Shop the sale',
  }, FAKE_TENANT_ID);
  assert.ok('oneOff' in result, `expected success for ${VALID_NEAR_FUTURE}, got: ${JSON.stringify(result)}`);
});

test('ancient year on milestoneDate is also rejected', () => {
  const result = validateAndConvertOneOffBrief({
    name: 'Sale',
    campaignEndDate: VALID_NEAR_FUTURE,
    cta: 'Shop now',
    milestoneDate: '0004-01-01',
    milestoneLabel: 'Doors open',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.milestoneDate'],
      'ancient year on milestoneDate must be rejected');
  }
});
