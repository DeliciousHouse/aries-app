/**
 * Self-contained unit test for the onboarding variant-board rollout flag.
 * Mirrors tests/memory-honcho-env.test.ts: pure exported parser, injected env
 * objects, never touches process.env or a socket.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding/variant-board-flag.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isOnboardingVariantBoardEnabled } from '../../backend/onboarding/variant-board-env';

test('isOnboardingVariantBoardEnabled is false when the var is absent (default OFF)', () => {
  assert.equal(isOnboardingVariantBoardEnabled({}), false);
});

for (const truthy of ['1', 'true', 'TRUE', 'yes', 'Yes', 'on', 'ON', ' on ', 'true\n']) {
  test(`isOnboardingVariantBoardEnabled is true for ${JSON.stringify(truthy)}`, () => {
    assert.equal(isOnboardingVariantBoardEnabled({ ARIES_ONBOARDING_VARIANT_BOARD_ENABLED: truthy }), true);
  });
}

for (const falsy of ['', '0', 'false', 'no', 'off', 'enabled', 'maybe', '2']) {
  test(`isOnboardingVariantBoardEnabled is false for ${JSON.stringify(falsy)}`, () => {
    assert.equal(isOnboardingVariantBoardEnabled({ ARIES_ONBOARDING_VARIANT_BOARD_ENABLED: falsy }), false);
  });
}
