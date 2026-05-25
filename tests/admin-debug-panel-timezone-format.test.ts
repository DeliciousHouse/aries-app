import assert from 'node:assert/strict';
import test from 'node:test';

import { formatInTenantZone, tenantZoneAbbreviation } from '../lib/format-timestamp.js';

const KNOWN_UTC = '2026-06-15T03:59:59.000Z';

function formatUtcTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  return `${isoString.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`;
}

function formatTenantTime(isoString: string | null | undefined, tz: string): string {
  if (!isoString) return '—';
  return `${formatInTenantZone(isoString, tz)} ${tenantZoneAbbreviation(isoString, tz)}`;
}

test('formatUtcTime renders raw UTC suffix', () => {
  const result = formatUtcTime(KNOWN_UTC);
  assert.equal(result, '2026-06-15 03:59:59 UTC');
});

test('formatTenantTime renders America/Los_Angeles offset for known UTC instant', () => {
  const result = formatTenantTime(KNOWN_UTC, 'America/Los_Angeles');
  // 2026-06-15T03:59:59Z is 2026-06-14 20:59 PDT (UTC-7 in summer)
  assert.match(result, /Jun 14/, 'LA date should be June 14 (day before in UTC)');
  assert.match(result, /PDT|PT/, 'should include Pacific timezone abbreviation');
});

test('formatTenantTime renders Asia/Tokyo offset for known UTC instant', () => {
  const result = formatTenantTime(KNOWN_UTC, 'Asia/Tokyo');
  // 2026-06-15T03:59:59Z is 2026-06-15 12:59 JST (UTC+9)
  assert.match(result, /Jun 15/, 'Tokyo date should be June 15');
  assert.match(result, /JST|GMT\+9/, 'should include Japan timezone abbreviation');
});

test('formatTenantTime returns — for null input', () => {
  assert.equal(formatTenantTime(null, 'America/New_York'), '—');
  assert.equal(formatTenantTime(undefined, 'America/New_York'), '—');
});

test('formatUtcTime returns — for null input', () => {
  assert.equal(formatUtcTime(null), '—');
  assert.equal(formatUtcTime(undefined), '—');
});
