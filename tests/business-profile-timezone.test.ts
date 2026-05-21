import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_TENANT_TIMEZONE, isValidTimeZone, resolveTenantTimeZone } from '../lib/format-timestamp';
import {
  INVALID_TIMEZONE_ERROR,
  mergePersistedTimezoneField,
  normalizeStoredTimezone,
} from '../backend/tenant/business-profile';

/**
 * A4 — per-tenant business timezone. The `business_profiles.timezone` column
 * and INSERT/UPDATE SQL are exercised by the live-DB / verify suite. This test
 * covers the deterministic, DB-free units the route and file/DB save paths
 * both rely on:
 *  - `normalizeStoredTimezone` — the gate applied when loading a stored record
 *    (file OR db row): a valid IANA value is kept, anything else becomes null.
 *  - `mergePersistedTimezoneField` — the update merge: rejects non-IANA input
 *    with a typed error, leaves an unchanged value alone.
 */

test('timezone validation rejects non-IANA strings', () => {
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('Europe/Paris'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('EST'), false);
  assert.equal(isValidTimeZone('GMT+5'), false);
  assert.equal(isValidTimeZone('Pacific Time'), false);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(undefined), false);
});

test('normalizeStoredTimezone keeps valid zones and nulls everything else', () => {
  assert.equal(normalizeStoredTimezone('America/Los_Angeles'), 'America/Los_Angeles');
  assert.equal(normalizeStoredTimezone('UTC'), 'UTC');
  assert.equal(normalizeStoredTimezone('  Europe/London  '), 'Europe/London');
  // Junk a legacy or hand-edited record file might carry:
  assert.equal(normalizeStoredTimezone('EST5EDT-bogus'), null);
  assert.equal(normalizeStoredTimezone(''), null);
  assert.equal(normalizeStoredTimezone(null), null);
  assert.equal(normalizeStoredTimezone(undefined), null);
  assert.equal(normalizeStoredTimezone(42), null);
});

test('unset stored timezone resolves to the fixed fallback (no browser-detect)', () => {
  // normalizeStoredTimezone -> null, then the view layer applies the fallback.
  assert.equal(resolveTenantTimeZone(normalizeStoredTimezone(null)), DEFAULT_TENANT_TIMEZONE);
  assert.equal(resolveTenantTimeZone(normalizeStoredTimezone('garbage')), DEFAULT_TENANT_TIMEZONE);
  assert.equal(resolveTenantTimeZone(normalizeStoredTimezone('Asia/Tokyo')), 'Asia/Tokyo');
});

test('mergePersistedTimezoneField accepts a valid IANA update', () => {
  const merged = mergePersistedTimezoneField('America/New_York', 'America/Chicago');
  assert.equal(merged.value, 'America/Chicago');
  assert.equal(merged.changed, true);
});

test('mergePersistedTimezoneField rejects a non-IANA update with a typed error', () => {
  assert.throws(
    () => mergePersistedTimezoneField('America/New_York', 'Eastern'),
    (error: unknown) =>
      error instanceof Error && error.message.startsWith(`${INVALID_TIMEZONE_ERROR}:`),
  );
});

test('mergePersistedTimezoneField leaves the current value when input is absent/blank', () => {
  assert.deepEqual(mergePersistedTimezoneField('America/Denver', undefined), {
    value: 'America/Denver',
    changed: false,
  });
  assert.deepEqual(mergePersistedTimezoneField('America/Denver', null), {
    value: 'America/Denver',
    changed: false,
  });
  assert.deepEqual(mergePersistedTimezoneField('America/Denver', '   '), {
    value: 'America/Denver',
    changed: false,
  });
});

test('mergePersistedTimezoneField reports changed=false when the value is unchanged', () => {
  const merged = mergePersistedTimezoneField('Europe/Paris', 'Europe/Paris');
  assert.equal(merged.value, 'Europe/Paris');
  assert.equal(merged.changed, false);
});
