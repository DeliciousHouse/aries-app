import assert from 'node:assert/strict';
import test from 'node:test';

import { isAiPostingTimesEnabled } from '../backend/marketing/posting-times-env';

test('isAiPostingTimesEnabled: truthy values enable tenant 15 only', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    const env = { ARIES_AI_POSTING_TIMES_ENABLED: v };
    assert.equal(isAiPostingTimesEnabled(env, 15), true, `"${v}" should enable tenant 15`);
    assert.equal(isAiPostingTimesEnabled(env, 16), false, `"${v}" must not enable tenant 16`);
    assert.equal(isAiPostingTimesEnabled(env), false, `"${v}" without a tenant must fail closed`);
  }
});

test('isAiPostingTimesEnabled: falsy / unset values disable', () => {
  for (const v of ['0', 'false', 'no', 'off', '', 'enabled', undefined]) {
    assert.equal(
      isAiPostingTimesEnabled({ ARIES_AI_POSTING_TIMES_ENABLED: v }, 15),
      false,
      `"${String(v)}" should disable`,
    );
  }
  assert.equal(isAiPostingTimesEnabled({}, 15), false, 'unset should disable (default OFF)');
});
