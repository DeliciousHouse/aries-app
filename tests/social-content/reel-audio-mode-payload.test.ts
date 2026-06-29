import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeWeeklySocialContentPayload } from '../../backend/social-content/payload';

/**
 * The per-job reel audio override rides the weekly social-content payload (it
 * lands in doc.inputs.request.reelAudioMode and is read at reel ingest time).
 * normalizeWeeklySocialContentPayload must:
 *  - keep a recognized value, normalized to its canonical form, and
 *  - drop an absent/blank/unrecognized value so the per-tenant default applies.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/social-content/reel-audio-mode-payload.test.ts
 */

test('keeps and canonicalizes a recognized reelAudioMode override', () => {
  const out = normalizeWeeklySocialContentPayload({
    brandUrl: 'https://acme.example',
    reelAudioMode: 'VOICE-OVER',
  });
  assert.equal(out.reelAudioMode, 'voiceover');

  assert.equal(
    normalizeWeeklySocialContentPayload({ reelAudioMode: 'both' }).reelAudioMode,
    'both',
  );
});

test('drops an absent / blank / unrecognized reelAudioMode', () => {
  assert.equal('reelAudioMode' in normalizeWeeklySocialContentPayload({}), false);
  assert.equal(
    'reelAudioMode' in normalizeWeeklySocialContentPayload({ reelAudioMode: '' }),
    false,
  );
  assert.equal(
    'reelAudioMode' in normalizeWeeklySocialContentPayload({ reelAudioMode: 'loud' }),
    false,
  );
});
