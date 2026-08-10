/**
 * tests/insights-object-health.test.ts
 *
 * The pure quarantine decision logic (backend/insights/sync/object-health.ts).
 * Real Graph error strings on the permanent side, real transient ones on the
 * negative side, and the two guards that stop quarantine from being a
 * data-deleting footgun: the transient override, and `postSpecific`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPermanentObjectError,
  shouldQuarantine,
  quarantineThreshold,
  quarantineThresholdFor,
  QUARANTINE_STRIKES_PERMANENT,
  QUARANTINE_STRIKES_GENERIC,
  QUARANTINE_NEVER_THRESHOLD,
  REPROBE_AFTER_DAYS,
} from '@/backend/insights/sync/object-health';

test('recognises the Graph errors that mean the object is gone for good', () => {
  const permanent = [
    '(#100) Object with ID \'123_456\' does not exist, cannot be loaded due to missing permissions, or does not support this operation',
    'Unsupported get request. Object with ID \'17900000000\' does not exist',
    '(#100) Tried accessing nonexisting field (insights) on node type (Post)',
    'GraphError: Object with ID "PAGE_1" does not exist',
  ];
  for (const message of permanent) {
    assert.equal(isPermanentObjectError(message), true, message);
  }
});

test('transient errors are never permanent, even when they quote permanent text', () => {
  const transient = [
    '(#4) Application request limit reached',
    '(#17) User request limit reached',
    '(#32) Page request limit reached',
    'Request timed out',
    'The service is temporarily unavailable',
    'fetch failed',
    'ECONNRESET',
    'ETIMEDOUT',
    'socket hang up',
    'HTTP 503 Service Unavailable',
    'Bad Gateway',
    // The override case: rate-limit body that ALSO carries a permanent marker.
    // Burning a fast strike here would quarantine a perfectly live object.
    '(#4) Application request limit reached while resolving: Object with ID \'1\' does not exist',
  ];
  for (const message of transient) {
    assert.equal(isPermanentObjectError(message), false, message);
  }
});

test('an unrecognised error is not permanent (it still converges, just slower)', () => {
  assert.equal(isPermanentObjectError('something nobody has seen before'), false);
  assert.equal(isPermanentObjectError(''), false);
  assert.equal(isPermanentObjectError(undefined as unknown as string), false);
});

test('thresholds: permanent converges faster than generic', () => {
  assert.equal(quarantineThreshold(true), QUARANTINE_STRIKES_PERMANENT);
  assert.equal(quarantineThreshold(false), QUARANTINE_STRIKES_GENERIC);
  assert.ok(QUARANTINE_STRIKES_PERMANENT < QUARANTINE_STRIKES_GENERIC);
});

test('shouldQuarantine crosses at the threshold, not before', () => {
  // Permanent: 2 strikes.
  assert.equal(shouldQuarantine({ errorCount: 0, permanent: true, postSpecific: true }), false);
  assert.equal(shouldQuarantine({ errorCount: 1, permanent: true, postSpecific: true }), true);
  // Generic: 5 strikes. Any success resets errorCount to 0, so a flaky object
  // never gets here.
  for (let n = 0; n < QUARANTINE_STRIKES_GENERIC - 1; n++) {
    assert.equal(shouldQuarantine({ errorCount: n, permanent: false, postSpecific: true }), false, `errorCount=${n}`);
  }
  assert.equal(
    shouldQuarantine({ errorCount: QUARANTINE_STRIKES_GENERIC - 1, permanent: false, postSpecific: true }),
    true,
  );
});

test('postSpecific=false NEVER quarantines — a platform outage must not wipe an account', () => {
  assert.equal(shouldQuarantine({ errorCount: 999, permanent: true, postSpecific: false }), false);
  assert.equal(shouldQuarantine({ errorCount: 999, permanent: false, postSpecific: false }), false);
});

test('quarantineThresholdFor binds a never-reachable threshold when not object-specific', () => {
  assert.equal(quarantineThresholdFor({ permanent: true, postSpecific: true }), QUARANTINE_STRIKES_PERMANENT);
  assert.equal(quarantineThresholdFor({ permanent: false, postSpecific: true }), QUARANTINE_STRIKES_GENERIC);
  assert.equal(quarantineThresholdFor({ permanent: true, postSpecific: false }), QUARANTINE_NEVER_THRESHOLD);
  assert.equal(quarantineThresholdFor({ permanent: false, postSpecific: false }), QUARANTINE_NEVER_THRESHOLD);
  // int4 max — it is bound into an `error_count + 1 >= $3` comparison, so it
  // must survive a Postgres INT column without overflowing.
  assert.equal(QUARANTINE_NEVER_THRESHOLD, 2147483647);
});

test('a quarantined object is re-probed, so it can heal without an operator', () => {
  assert.ok(REPROBE_AFTER_DAYS > 0 && REPROBE_AFTER_DAYS <= 30);
});
