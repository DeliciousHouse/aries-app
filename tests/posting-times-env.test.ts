import assert from 'node:assert/strict';
import test from 'node:test';

import { isAiPostingTimesEnabled } from '../backend/marketing/posting-times-env';

test('isAiPostingTimesEnabled: truthy values enable', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(isAiPostingTimesEnabled({ ARIES_AI_POSTING_TIMES_ENABLED: v }), true, `"${v}" should enable`);
  }
});

test('isAiPostingTimesEnabled: falsy / unset values disable', () => {
  for (const v of ['0', 'false', 'no', 'off', '', 'enabled', undefined]) {
    assert.equal(
      isAiPostingTimesEnabled({ ARIES_AI_POSTING_TIMES_ENABLED: v }),
      false,
      `"${String(v)}" should disable`,
    );
  }
  assert.equal(isAiPostingTimesEnabled({}), false, 'unset should disable (default OFF)');
});
