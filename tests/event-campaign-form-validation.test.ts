import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndConvertEventBrief } from '@/app/api/marketing/jobs/handler';

// T8: server-side validation + tz conversion for the event_campaign brief.
// validateAndConvertEventBrief is the boundary where the form's YYYY-MM-DD
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
  const result = validateAndConvertEventBrief({}, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result, 'expected fieldErrors for empty payload');
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['event.eventName']);
    assert.ok(result.fieldErrors['event.eventDate']);
    assert.ok(result.fieldErrors['event.registrationDeadline']);
    assert.ok(result.fieldErrors['event.campaignEndDate']);
    assert.ok(result.fieldErrors['event.cta']);
  }
});

test('null/undefined payload yields fieldErrors, not a crash', () => {
  const result = validateAndConvertEventBrief(null, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  const result2 = validateAndConvertEventBrief(undefined, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result2);
});

test('non-YYYY-MM-DD date format rejected with structured error', () => {
  const result = validateAndConvertEventBrief({
    eventName: 'Aries AI Hackathon',
    eventDate: '06/10/2026',
    registrationDeadline: '2026-06-10',
    campaignEndDate: '2026-06-10',
    cta: 'Register',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['event.eventDate']);
  }
});

test('registrationDeadline after eventDate rejected', () => {
  const result = validateAndConvertEventBrief({
    eventName: 'Aries AI Hackathon',
    eventDate: '2026-06-10',
    registrationDeadline: '2026-06-15',
    campaignEndDate: '2026-06-20',
    cta: 'Register',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['event.registrationDeadline']);
  }
});

test('campaignEndDate before eventDate rejected', () => {
  const result = validateAndConvertEventBrief({
    eventName: 'Aries AI Hackathon',
    eventDate: '2026-06-10',
    registrationDeadline: '2026-06-09',
    campaignEndDate: '2026-06-05',
    cta: 'Register',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['event.campaignEndDate']);
  }
});

test('valid payload converts dates to America/New_York end-of-day UTC ISO', () => {
  // No business profile on disk for FAKE_TENANT_ID, so the helper falls back
  // to America/New_York (DEFAULT_TENANT_TIMEZONE). June 10 2026 is EDT (UTC-4).
  // End-of-day in NY = 23:59:59 EDT = 03:59:59 UTC on June 11.
  const result = validateAndConvertEventBrief({
    eventName: 'Aries AI Hackathon',
    eventDate: '2026-06-10',
    registrationDeadline: '2026-06-10',
    campaignEndDate: '2026-06-10',
    cta: 'Register at aries.example.com/hackathon',
  }, FAKE_TENANT_ID);
  assert.ok('event' in result, 'expected converted event payload');
  if ('event' in result) {
    assert.equal(result.event.eventName, 'Aries AI Hackathon');
    assert.equal(result.event.cta, 'Register at aries.example.com/hackathon');
    // All three dates become the same UTC instant (same calendar date, same
    // end-of-day in the tenant zone). On EDT (UTC-4) this is 03:59:59 UTC
    // on June 11.
    assert.equal(result.event.campaignEndDate, '2026-06-11T03:59:59.000Z');
    assert.equal(result.event.eventDate, '2026-06-11T03:59:59.000Z');
    assert.equal(result.event.registrationDeadline, '2026-06-11T03:59:59.000Z');
  }
});

test('whitespace-only fields treated as missing', () => {
  const result = validateAndConvertEventBrief({
    eventName: '   ',
    eventDate: '2026-06-10',
    registrationDeadline: '2026-06-10',
    campaignEndDate: '2026-06-10',
    cta: '   ',
  }, FAKE_TENANT_ID);
  assert.ok('fieldErrors' in result);
  if ('fieldErrors' in result) {
    assert.ok(result.fieldErrors['event.eventName']);
    assert.ok(result.fieldErrors['event.cta']);
  }
});
