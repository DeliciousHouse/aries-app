import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUSINESS_TYPES,
  filterBusinessTypes,
  topGhostSuffix,
} from '../frontend/onboarding/pipeline-intake/business-types';

test('BUSINESS_TYPES has at least 60 entries and no duplicates', () => {
  assert.ok(BUSINESS_TYPES.length >= 60, `expected >=60 entries, got ${BUSINESS_TYPES.length}`);
  const seen = new Set<string>();
  for (const entry of BUSINESS_TYPES) {
    const key = entry.toLowerCase().trim();
    assert.ok(!seen.has(key), `duplicate entry: ${entry}`);
    seen.add(key);
  }
});

test('filterBusinessTypes returns full list for empty query', () => {
  assert.equal(filterBusinessTypes(''), BUSINESS_TYPES);
  assert.equal(filterBusinessTypes('   '), BUSINESS_TYPES);
});

test('filterBusinessTypes filters case-insensitively by substring', () => {
  const results = filterBusinessTypes('saas');
  assert.ok(results.length >= 2, 'expected multiple SaaS entries');
  for (const entry of results) {
    assert.match(entry.toLowerCase(), /saas/);
  }
});

test('filterBusinessTypes returns empty array when nothing matches', () => {
  assert.deepEqual(filterBusinessTypes('zzz-not-a-real-vertical'), []);
});

test('topGhostSuffix returns suffix of top match minus what user typed', () => {
  assert.equal(topGhostSuffix('ec', BUSINESS_TYPES), 'ommerce / DTC brand');
});

test('topGhostSuffix is case-insensitive on the prefix match but preserves source casing in suffix', () => {
  assert.equal(topGhostSuffix('EC', BUSINESS_TYPES), 'ommerce / DTC brand');
});

test('topGhostSuffix returns empty string when no entry begins with the query', () => {
  assert.equal(topGhostSuffix('zzz', BUSINESS_TYPES), '');
});

test('topGhostSuffix returns empty string for empty/whitespace query', () => {
  assert.equal(topGhostSuffix('', BUSINESS_TYPES), '');
  assert.equal(topGhostSuffix('   ', BUSINESS_TYPES), '');
});
