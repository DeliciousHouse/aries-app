/**
 * ARIES_PERF_CONTEXT_ENABLED is a default-ON flag — the inverse of
 * ARIES_AI_POSTING_TIMES_ENABLED — so "unset" must enable, and only the
 * explicit off-words disable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isPerfContextEnabled } from '../backend/marketing/performance-context-env';

test('isPerfContextEnabled: unset / blank enables (default ON)', () => {
  assert.equal(isPerfContextEnabled({}), true, 'unset should enable');
  for (const v of ['', '   ', undefined]) {
    assert.equal(
      isPerfContextEnabled({ ARIES_PERF_CONTEXT_ENABLED: v }),
      true,
      `"${String(v)}" should enable`,
    );
  }
});

test('isPerfContextEnabled: explicit off-words disable', () => {
  for (const v of ['0', 'false', 'FALSE', 'no', 'off', ' OFF ']) {
    assert.equal(
      isPerfContextEnabled({ ARIES_PERF_CONTEXT_ENABLED: v }),
      false,
      `"${v}" should disable`,
    );
  }
});

test('isPerfContextEnabled: anything else enables', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'anything']) {
    assert.equal(
      isPerfContextEnabled({ ARIES_PERF_CONTEXT_ENABLED: v }),
      true,
      `"${v}" should enable`,
    );
  }
});
