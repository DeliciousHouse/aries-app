import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isBrandVoiceManuallyEdited,
  resolveBrandVoiceForPreview,
} from '../frontend/aries-v1/onboarding-brand-voice';

test('a persisted scraped voice remains derived while a corrected voice is manual', () => {
  assert.equal(
    isBrandVoiceManuallyEdited('Warm and direct', 'Warm and direct'),
    false,
  );
  assert.equal(
    isBrandVoiceManuallyEdited('Playful and concise', 'Warm and direct'),
    true,
  );
  assert.equal(isBrandVoiceManuallyEdited('Confirmed voice', null), true);
  assert.equal(isBrandVoiceManuallyEdited('', 'Warm and direct'), false);
});

test('a source change replaces or clears only an unedited scraped voice', () => {
  assert.equal(
    resolveBrandVoiceForPreview('Voice from site A', 'Voice from site B', false),
    'Voice from site B',
  );
  assert.equal(
    resolveBrandVoiceForPreview('Voice from site A', null, false),
    '',
  );
  assert.equal(
    resolveBrandVoiceForPreview('Operator correction', 'Voice from site B', true),
    'Operator correction',
  );
});
