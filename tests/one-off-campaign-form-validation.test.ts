import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndConvertOneOffBrief } from '@/app/api/marketing/jobs/handler';

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
    campaignEndDate: '2026-06-14',
    cta: 'Pre-order now',
    milestoneDate: '2026-06-10',
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
    campaignEndDate: '2026-06-14',
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
    campaignEndDate: '2026-06-10',
    cta: 'Save your seat',
    milestoneDate: '2026-06-15',
    milestoneLabel: 'Doors open',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.milestoneDate']);
  }
});

test('valid minimal payload converts campaignEndDate to NY end-of-day UTC', () => {
  // June 10 2026 in EDT (UTC-4). End-of-day NY = 23:59:59 EDT = 03:59:59 UTC on June 11.
  const result = validateAndConvertOneOffBrief({
    name: 'Summer Flash Sale',
    campaignEndDate: '2026-06-10',
    cta: 'Shop the sale',
  }, FAKE_TENANT_ID);
  assert.ok('oneOff' in result);
  if ('oneOff' in result) {
    assert.equal(result.oneOff.name, 'Summer Flash Sale');
    assert.equal(result.oneOff.cta, 'Shop the sale');
    assert.equal(result.oneOff.campaignEndDate, '2026-06-11T03:59:59.000Z');
    assert.equal(result.oneOff.milestoneDate, undefined);
    assert.equal(result.oneOff.milestoneLabel, undefined);
  }
});

test('valid payload with milestone produces both UTC instants and label', () => {
  const result = validateAndConvertOneOffBrief({
    name: 'Aries AI Hackathon',
    campaignEndDate: '2026-06-14',
    cta: 'Register at example.com/hackathon',
    milestoneDate: '2026-06-10',
    milestoneLabel: 'Registration deadline',
  }, FAKE_TENANT_ID);
  assert.ok('oneOff' in result);
  if ('oneOff' in result) {
    assert.equal(result.oneOff.campaignEndDate, '2026-06-15T03:59:59.000Z');
    assert.equal(result.oneOff.milestoneDate, '2026-06-11T03:59:59.000Z');
    assert.equal(result.oneOff.milestoneLabel, 'Registration deadline');
  }
});

test('whitespace-only fields treated as missing', () => {
  const result = validateAndConvertOneOffBrief({
    name: '   ',
    campaignEndDate: '2026-06-10',
    cta: '   ',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['oneOff.name']);
    assert.ok(result.fieldErrors['oneOff.cta']);
  }
});
