/**
 * Rollout-gate unit tests for weekly-reel + reel-voiceover feature flags.
 *
 * Covers (pure, no I/O):
 *   isWeeklyReelEnabled   (ARIES_WEEKLY_REEL_ENABLED)
 *   isReelVoiceoverEnabled (ARIES_REEL_VOICEOVER_ENABLED)
 *
 *   - Both default OFF when the env var is absent or empty.
 *   - '1', 'true', 'yes', 'on' (and case/whitespace variants) enable the flag.
 *   - '0', 'false', 'off' keep it disabled.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/weekly-reel-env.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isWeeklyReelEnabled } from '../../backend/marketing/weekly-reel-env';
import { isReelVoiceoverEnabled } from '../../backend/integrations/elevenlabs/voiceover-env';

// ---------------------------------------------------------------------------
// isWeeklyReelEnabled
// ---------------------------------------------------------------------------

test('isWeeklyReelEnabled: default OFF when env is empty object', () => {
  assert.equal(isWeeklyReelEnabled({}), false);
});

test('isWeeklyReelEnabled: default OFF when var is absent (undefined)', () => {
  assert.equal(isWeeklyReelEnabled({ ARIES_WEEKLY_REEL_ENABLED: undefined }), false);
});

test('isWeeklyReelEnabled: truthy values turn it ON', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'YES', 'ON', ' On ', ' 1 ']) {
    assert.equal(
      isWeeklyReelEnabled({ ARIES_WEEKLY_REEL_ENABLED: v }),
      true,
      `expected ON for value '${v}'`,
    );
  }
});

test('isWeeklyReelEnabled: falsy values keep it OFF', () => {
  for (const v of ['0', 'false', 'off', 'no', 'False', '', 'nope', '2', 'enabled']) {
    assert.equal(
      isWeeklyReelEnabled({ ARIES_WEEKLY_REEL_ENABLED: v }),
      false,
      `expected OFF for value '${v}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// isReelVoiceoverEnabled
// ---------------------------------------------------------------------------

test('isReelVoiceoverEnabled: default OFF when env is empty object', () => {
  assert.equal(isReelVoiceoverEnabled({}), false);
});

test('isReelVoiceoverEnabled: default OFF when var is absent (undefined)', () => {
  assert.equal(isReelVoiceoverEnabled({ ARIES_REEL_VOICEOVER_ENABLED: undefined }), false);
});

test('isReelVoiceoverEnabled: truthy values turn it ON', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'YES', 'ON', ' On ', ' 1 ']) {
    assert.equal(
      isReelVoiceoverEnabled({ ARIES_REEL_VOICEOVER_ENABLED: v }),
      true,
      `expected ON for value '${v}'`,
    );
  }
});

test('isReelVoiceoverEnabled: falsy values keep it OFF', () => {
  for (const v of ['0', 'false', 'off', 'no', 'False', '', 'nope', '2', 'enabled']) {
    assert.equal(
      isReelVoiceoverEnabled({ ARIES_REEL_VOICEOVER_ENABLED: v }),
      false,
      `expected OFF for value '${v}'`,
    );
  }
});
