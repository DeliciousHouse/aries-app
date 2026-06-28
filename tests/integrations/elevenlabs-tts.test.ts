/**
 * Unit tests for the ElevenLabs TTS helpers.
 *
 * All tests are pure / deterministic — no network I/O, no filesystem writes.
 *
 * Covers:
 *   fitCopyToDuration
 *     - trims to the word budget (seconds * 2.6 rounded)
 *     - joins hook / value / cta with '. '
 *     - handles absent / empty fields gracefully
 *     - never exceeds the word budget regardless of input length
 *     - strips trailing clause-break punctuation after trimming
 *
 *   synthesizeVoiceover
 *     - returns null (never throws) when ELEVENLABS_API_KEY is unset
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/integrations/elevenlabs-tts.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fitCopyToDuration,
  synthesizeVoiceover,
} from '../../backend/integrations/elevenlabs/tts';

// ---------------------------------------------------------------------------
// fitCopyToDuration — word-budget trimming
// ---------------------------------------------------------------------------

test('fitCopyToDuration: full text fits when total words <= budget', () => {
  // 30 seconds → budget = Math.max(1, Math.round(30 * 2.6)) = 78 words.
  // 6 words total → well within budget → full text returned unchanged.
  const result = fitCopyToDuration(
    { hook: 'Hook text', value: 'Value text', cta: 'CTA text' },
    30,
  );
  assert.equal(result, 'Hook text. Value text. CTA text');
});

test('fitCopyToDuration: joins non-empty parts with \'. \'', () => {
  const result = fitCopyToDuration({ hook: 'Alpha', value: 'Beta', cta: 'Gamma' }, 60);
  assert.equal(result, 'Alpha. Beta. Gamma');
});

test('fitCopyToDuration: skips empty or whitespace-only parts', () => {
  const result = fitCopyToDuration({ hook: 'Hello', value: '   ', cta: '' }, 60);
  assert.equal(result, 'Hello', 'blank value and empty cta should be omitted');
});

test('fitCopyToDuration: handles all fields absent (undefined)', () => {
  const result = fitCopyToDuration({}, 10);
  assert.equal(result, '', 'no fields → empty string, no throw');
});

test('fitCopyToDuration: handles all fields empty strings', () => {
  const result = fitCopyToDuration({ hook: '', value: '', cta: '' }, 10);
  assert.equal(result, '');
});

test('fitCopyToDuration: trims to word budget when text is longer', () => {
  // 3 seconds → budget = Math.max(1, Math.round(3 * 2.6)) = max(1, 8) = 8 words
  const longHook = 'one two three four five six seven eight nine ten eleven twelve';
  const result = fitCopyToDuration({ hook: longHook }, 3);
  const wordCount = result.trim().split(/\s+/).filter(Boolean).length;
  assert.ok(
    wordCount <= 8,
    `expected ≤ 8 words, got ${wordCount} in: "${result}"`,
  );
});

test('fitCopyToDuration: never exceeds budget even with all three long fields', () => {
  // 2 seconds → budget = Math.max(1, Math.round(2 * 2.6)) = max(1, 5) = 5 words
  const copy = {
    hook: 'alpha bravo charlie delta echo foxtrot golf',
    value: 'hotel india juliet kilo lima',
    cta: 'mike november oscar papa',
  };
  const result = fitCopyToDuration(copy, 2);
  const wordCount = result.trim().split(/\s+/).filter(Boolean).length;
  assert.ok(
    wordCount <= 5,
    `expected ≤ 5 words, got ${wordCount} in: "${result}"`,
  );
});

test('fitCopyToDuration: strips trailing comma after trim', () => {
  // 1-word budget → budget = max(1, Math.round(0.38)) = 1
  // The first word from 'a, b, c' is 'a,' — trailing comma must be stripped
  // so the TTS engine ends naturally rather than mid-phrase.
  // Use 0.38 seconds: Math.round(0.38 * 2.6) = Math.round(0.988) = 1.
  const result = fitCopyToDuration({ hook: 'a, b, c,' }, 0.38);
  assert.ok(!result.endsWith(','), `trailing comma not stripped: "${result}"`);
  assert.ok(!result.endsWith(';'), `trailing semicolon not stripped: "${result}"`);
  assert.ok(!result.endsWith(':'), `trailing colon not stripped: "${result}"`);
});

test('fitCopyToDuration: strips trailing semicolon after trim', () => {
  // Verify the regex covers all three clause-break chars.
  // Feed words that end with ';' so the last trimmed word has a trailing semicolon.
  // 2 seconds → 5 words budget. Use 6 words where the 5th ends in ';'.
  const result = fitCopyToDuration({ hook: 'a b c d e; f g h' }, 2);
  assert.ok(!result.endsWith(';'), `trailing semicolon not stripped: "${result}"`);
});

test('fitCopyToDuration: budget of 1 yields exactly one token', () => {
  // 0 seconds → targetWords = Math.max(1, Math.round(0)) = 1
  const result = fitCopyToDuration({ hook: 'one two three' }, 0);
  const wordCount = result.trim().split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount <= 1, `expected ≤ 1 word, got ${wordCount}`);
});

test('fitCopyToDuration: hook-only copy produces correct word count at target seconds', () => {
  // 10 seconds → budget = Math.max(1, Math.round(10 * 2.6)) = 26
  const twentyWords = Array.from({ length: 30 }, (_, i) => `word${i + 1}`).join(' ');
  const result = fitCopyToDuration({ hook: twentyWords }, 10);
  const words = result.trim().split(/\s+/).filter(Boolean);
  assert.ok(words.length <= 26, `expected ≤ 26 words, got ${words.length}`);
  // Also verify it is not over-trimmed — it should have exactly 26 (the budget).
  assert.equal(words.length, 26, 'should use the full budget when input exceeds it');
});

test('fitCopyToDuration: CTA is preserved when hook+value exceed the word budget', () => {
  // 3 seconds → budget = Math.max(1, Math.round(3 * 2.6)) = 8 words.
  // hook(6) + value(4) + cta(2) = 12 words > 8. CTA must be in the result.
  const result = fitCopyToDuration(
    { hook: 'one two three four five six', value: 'seven eight nine ten', cta: 'Buy Now' },
    3,
  );
  const wordCount = result.trim().split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount <= 8, `expected ≤ 8 words, got ${wordCount}: "${result}"`);
  assert.ok(result.includes('Buy Now'), `CTA must be preserved; got: "${result}"`);
});

// ---------------------------------------------------------------------------
// synthesizeVoiceover — no-key fast-path
// ---------------------------------------------------------------------------

test('synthesizeVoiceover: returns null without throwing when API key is absent', async () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  try {
    delete process.env.ELEVENLABS_API_KEY;
    const result = await synthesizeVoiceover({
      text: 'Hello world',
      outPath: '/tmp/aries-test-vo.mp3',
    });
    assert.equal(result, null, 'must return null, not throw, when the key is absent');
  } finally {
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
  }
});

test('synthesizeVoiceover: returns null (not throw) even when text is empty', async () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  try {
    delete process.env.ELEVENLABS_API_KEY;
    const result = await synthesizeVoiceover({
      text: '',
      outPath: '/tmp/aries-test-vo-empty.mp3',
    });
    assert.equal(result, null);
  } finally {
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
  }
});
