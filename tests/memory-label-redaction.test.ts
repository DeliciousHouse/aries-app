import assert from 'node:assert/strict';
import test from 'node:test';

import { scrubPreferenceLabelForHoncho } from '../backend/memory/write-events';

/**
 * Safely set env vars for the duration of fn, restoring originals on return.
 * Mirrors the helper used in tests/memory-write-events.test.ts.
 */
function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(updates)) {
    original[key] = process.env[key];
    if (updates[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = updates[key]!;
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key]!;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Flag OFF — legacy regression behavior must be preserved.
// ---------------------------------------------------------------------------

test('scrubPreferenceLabelForHoncho (flag OFF) preserves legacy broad name scrub', () => {
  withEnv({ ARIES_MEMORY_LABEL_REDACTION_V2: undefined }, () => {
    // Creative descriptors get scrubbed under the legacy heuristic — this is
    // the regression we are intentionally locking in until the flag flips.
    assert.equal(scrubPreferenceLabelForHoncho('Bold Minimalist'), '[redacted_name]');
    assert.equal(scrubPreferenceLabelForHoncho('Quiet Luxury'), '[redacted_name]');
    // Real names scrub too.
    assert.equal(scrubPreferenceLabelForHoncho('John Smith'), '[redacted_name]');
    // Single tokens always pass through.
    assert.equal(scrubPreferenceLabelForHoncho('Minimalist'), 'Minimalist');
  });
});

test('scrubPreferenceLabelForHoncho (flag OFF, value="0") still uses legacy regex', () => {
  withEnv({ ARIES_MEMORY_LABEL_REDACTION_V2: '0' }, () => {
    assert.equal(scrubPreferenceLabelForHoncho('Bold Minimalist'), '[redacted_name]');
  });
});

// ---------------------------------------------------------------------------
// Flag ON — creative descriptors survive, real-name patterns still scrub.
// ---------------------------------------------------------------------------

test('scrubPreferenceLabelForHoncho (flag ON) preserves creative descriptors', () => {
  withEnv({ ARIES_MEMORY_LABEL_REDACTION_V2: '1' }, () => {
    const descriptors = [
      'Bold Minimalist',
      'Quiet Luxury',
      'Dark Academia',
      'Soft Brutalism',
      'Cottage Core',
      'Modern Bauhaus',
    ];
    for (const label of descriptors) {
      assert.equal(scrubPreferenceLabelForHoncho(label), label, `expected "${label}" to survive`);
    }
  });
});

test('scrubPreferenceLabelForHoncho (flag ON) still scrubs common first-name + last-name pairs', () => {
  withEnv({ ARIES_MEMORY_LABEL_REDACTION_V2: '1' }, () => {
    assert.equal(scrubPreferenceLabelForHoncho('John Smith'), '[redacted_name]');
    assert.equal(scrubPreferenceLabelForHoncho('Jane Doe'), '[redacted_name]');
    assert.equal(scrubPreferenceLabelForHoncho('Michael Jordan'), '[redacted_name]');
    assert.equal(scrubPreferenceLabelForHoncho('Sarah Connor'), '[redacted_name]');
  });
});

test('scrubPreferenceLabelForHoncho (flag ON) is case-insensitive on the first-name token', () => {
  withEnv({ ARIES_MEMORY_LABEL_REDACTION_V2: '1' }, () => {
    // Regex still requires Title-case to match, but the denylist lookup
    // lowercases the first token so "John" matches "john" in the set.
    assert.equal(scrubPreferenceLabelForHoncho('John Doe'), '[redacted_name]');
  });
});

test('scrubPreferenceLabelForHoncho (flag ON) handles mixed content', () => {
  withEnv({ ARIES_MEMORY_LABEL_REDACTION_V2: '1' }, () => {
    const input = 'Bold Minimalist by John Smith';
    const output = scrubPreferenceLabelForHoncho(input);
    assert.equal(output, 'Bold Minimalist by [redacted_name]');
  });
});

// ---------------------------------------------------------------------------
// Email — always redacted regardless of the flag.
// ---------------------------------------------------------------------------

test('scrubPreferenceLabelForHoncho redacts emails with flag OFF', () => {
  withEnv({ ARIES_MEMORY_LABEL_REDACTION_V2: undefined }, () => {
    assert.equal(
      scrubPreferenceLabelForHoncho('contact me at jane@example.com'),
      'contact me at [redacted_email]',
    );
  });
});

test('scrubPreferenceLabelForHoncho redacts emails with flag ON', () => {
  withEnv({ ARIES_MEMORY_LABEL_REDACTION_V2: '1' }, () => {
    assert.equal(
      scrubPreferenceLabelForHoncho('ping ops+aries@sugarandleather.com please'),
      'ping [redacted_email] please',
    );
  });
});

test('scrubPreferenceLabelForHoncho handles null/undefined/non-string input', () => {
  withEnv({ ARIES_MEMORY_LABEL_REDACTION_V2: '1' }, () => {
    assert.equal(scrubPreferenceLabelForHoncho(null), '');
    assert.equal(scrubPreferenceLabelForHoncho(undefined), '');
    assert.equal(scrubPreferenceLabelForHoncho(''), '');
    // @ts-expect-error — runtime guard against non-string input
    assert.equal(scrubPreferenceLabelForHoncho(42), '');
  });
});
