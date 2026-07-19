import assert from 'node:assert/strict';
import test from 'node:test';

import { computeAttributionCoverage } from '../backend/insights/attribution-coverage';

test('computeAttributionCoverage returns the attributed share and counts', () => {
  assert.deepEqual(
    computeAttributionCoverage({ totalPosts: 4, attributedPosts: 3 }, 0.8),
    {
      totalPosts: 4,
      attributedPosts: 3,
      coverage: 0.75,
      threshold: 0.8,
      isTrustworthy: false,
    },
  );
});

test('computeAttributionCoverage treats the threshold boundary as trustworthy', () => {
  const result = computeAttributionCoverage({ totalPosts: 5, attributedPosts: 4 }, 0.8);

  assert.equal(result.coverage, 0.8);
  assert.equal(result.isTrustworthy, true);
});

test('computeAttributionCoverage does not trust an empty window', () => {
  assert.deepEqual(
    computeAttributionCoverage({ totalPosts: 0, attributedPosts: 0 }, 0),
    {
      totalPosts: 0,
      attributedPosts: 0,
      coverage: 0,
      threshold: 0,
      isTrustworthy: false,
    },
  );
});

test('computeAttributionCoverage rejects thresholds outside the inclusive 0–1 range', () => {
  assert.throws(
    () => computeAttributionCoverage({ totalPosts: 1, attributedPosts: 1 }, -0.01),
    { name: 'RangeError' },
  );
  assert.throws(
    () => computeAttributionCoverage({ totalPosts: 1, attributedPosts: 1 }, 1.01),
    { name: 'RangeError' },
  );
  assert.throws(
    () => computeAttributionCoverage({ totalPosts: 1, attributedPosts: 1 }, Number.NaN),
    { name: 'RangeError' },
  );
});

test('computeAttributionCoverage rejects impossible post counts', () => {
  assert.throws(
    () => computeAttributionCoverage({ totalPosts: 2, attributedPosts: 3 }, 0.8),
    { name: 'RangeError' },
  );
  assert.throws(
    () => computeAttributionCoverage({ totalPosts: -1, attributedPosts: 0 }, 0.8),
    { name: 'RangeError' },
  );
  assert.throws(
    () => computeAttributionCoverage({ totalPosts: 1.5, attributedPosts: 1 }, 0.8),
    { name: 'RangeError' },
  );
});
