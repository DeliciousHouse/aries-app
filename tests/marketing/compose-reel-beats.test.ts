/**
 * Unit tests for the computeReelBeats() pure timeline helper.
 *
 * This function was extracted and exported specifically to lock in the
 * proportional-scaling fix: previously the beat boundaries were hardcoded to
 * the 15-second DEFAULT_REEL_SECONDS regardless of actual clip duration, so
 * a 6-second reel showed copy halfway through the card phase, and a 30-second
 * reel showed all its copy in the first half. computeReelBeats() scales every
 * boundary linearly with the clip duration (hookStart clamped to 0.3s min).
 *
 * These tests are purely deterministic — no ffmpeg, no filesystem, no network.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/compose-reel-beats.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeReelBeats } from '../../backend/marketing/marketing-layer/compose-reel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that the beats object for a given duration satisfies all ordering
 * and range invariants.
 */
function assertBeatsValid(duration: number): void {
  const b = computeReelBeats(duration);

  // Range: all values in [0, duration] (allowing floating-point rounding to
  // toFixed(2) which can produce exactly `duration`).
  const vals = [b.hookStart, b.hookEnd, b.valueStart, b.valueEnd, b.cardStart, b.ctaStart, b.urlStart, b.end];
  for (const v of vals) {
    assert.ok(
      v >= 0,
      `beat ${v} is negative for duration=${duration}`,
    );
    assert.ok(
      v <= duration + 0.01, // allow the toFixed(2) rounding margin
      `beat ${v} exceeds duration ${duration}`,
    );
  }

  // Ordering invariant: each phase boundary must come at or after the previous.
  assert.ok(b.hookStart < b.hookEnd, `hookStart(${b.hookStart}) must be < hookEnd(${b.hookEnd})`);
  assert.ok(b.hookEnd <= b.valueStart, `hookEnd(${b.hookEnd}) must be ≤ valueStart(${b.valueStart})`);
  assert.ok(b.valueStart < b.valueEnd, `valueStart(${b.valueStart}) must be < valueEnd(${b.valueEnd})`);
  assert.ok(b.valueEnd <= b.cardStart, `valueEnd(${b.valueEnd}) must be ≤ cardStart(${b.cardStart})`);
  assert.ok(b.cardStart <= b.ctaStart, `cardStart(${b.cardStart}) must be ≤ ctaStart(${b.ctaStart})`);
  assert.ok(b.ctaStart <= b.urlStart, `ctaStart(${b.ctaStart}) must be ≤ urlStart(${b.urlStart})`);
  assert.ok(b.urlStart <= b.end, `urlStart(${b.urlStart}) must be ≤ end(${b.end})`);

  // `end` must match the toFixed(2) rounding of the duration.
  assert.equal(b.end, +duration.toFixed(2), `end must equal toFixed(2) of duration`);
}

// ---------------------------------------------------------------------------
// Ordering and range
// ---------------------------------------------------------------------------

test('computeReelBeats: 6s clip — beats are ordered and in-range', () => {
  assertBeatsValid(6);
});

test('computeReelBeats: 15s clip (previous hardcoded default) — beats are ordered and in-range', () => {
  assertBeatsValid(15);
});

test('computeReelBeats: 20s clip — beats are ordered and in-range', () => {
  assertBeatsValid(20);
});

test('computeReelBeats: 30s clip — beats are ordered and in-range', () => {
  assertBeatsValid(30);
});

test('computeReelBeats: 60s clip — beats are ordered and in-range', () => {
  assertBeatsValid(60);
});

// ---------------------------------------------------------------------------
// Exact values for the 6s and 20s reference clips
// ---------------------------------------------------------------------------

test('computeReelBeats: exact beat values for a 6-second clip', () => {
  const b = computeReelBeats(6);
  // hookStart = Math.min(0.3, 6 * 0.02) = Math.min(0.3, 0.12) = 0.12
  assert.equal(b.hookStart, 0.12);
  // hookEnd = 6 * 0.33 = 1.98
  assert.equal(b.hookEnd, 1.98);
  // valueStart = 6 * 0.35 = 2.1
  assert.equal(b.valueStart, 2.10);
  // valueEnd = 6 * 0.66 = 3.96
  assert.equal(b.valueEnd, 3.96);
  // cardStart = 6 * 0.68 = 4.08
  assert.equal(b.cardStart, 4.08);
  // ctaStart = 4.08 + 6 * 0.04 = 4.08 + 0.24 = 4.32
  assert.equal(b.ctaStart, 4.32);
  // urlStart = 4.08 + 6 * 0.05 = 4.08 + 0.30 = 4.38
  assert.equal(b.urlStart, 4.38);
  // end = 6.00
  assert.equal(b.end, 6.00);
});

test('computeReelBeats: exact beat values for a 20-second clip', () => {
  const b = computeReelBeats(20);
  // hookStart = Math.min(0.3, 20 * 0.02) = Math.min(0.3, 0.4) = 0.3
  assert.equal(b.hookStart, 0.3);
  // hookEnd = 20 * 0.33 = 6.6
  assert.equal(b.hookEnd, 6.60);
  // valueStart = 20 * 0.35 = 7.0
  assert.equal(b.valueStart, 7.00);
  // valueEnd = 20 * 0.66 = 13.2
  assert.equal(b.valueEnd, 13.20);
  // cardStart = 20 * 0.68 = 13.6
  assert.equal(b.cardStart, 13.60);
  // ctaStart = 13.6 + 20 * 0.04 = 13.6 + 0.8 = 14.4
  assert.equal(b.ctaStart, 14.40);
  // urlStart = 13.6 + 20 * 0.05 = 13.6 + 1.0 = 14.6
  assert.equal(b.urlStart, 14.60);
  // end = 20.00
  assert.equal(b.end, 20.00);
});

// ---------------------------------------------------------------------------
// Proportionality: 20s clip boundaries scale relative to 6s clip
// ---------------------------------------------------------------------------

test('computeReelBeats: hookEnd scales proportionally with duration', () => {
  const b6 = computeReelBeats(6);
  const b20 = computeReelBeats(20);
  // hookEnd is D * 0.33; ratio must be 20/6.
  const ratio = b20.hookEnd / b6.hookEnd;
  assert.ok(
    Math.abs(ratio - 20 / 6) < 0.001,
    `hookEnd ratio ${ratio.toFixed(4)} should be ~${(20 / 6).toFixed(4)}`,
  );
});

test('computeReelBeats: cardStart scales proportionally with duration', () => {
  const b6 = computeReelBeats(6);
  const b20 = computeReelBeats(20);
  // cardStart is D * 0.68; ratio must be 20/6.
  const ratio = b20.cardStart / b6.cardStart;
  assert.ok(
    Math.abs(ratio - 20 / 6) < 0.001,
    `cardStart ratio ${ratio.toFixed(4)} should be ~${(20 / 6).toFixed(4)}`,
  );
});

// ---------------------------------------------------------------------------
// hookStart clamping: for clips shorter than 15s the guard prevents a negative
// or near-zero display window; for clips >= 15s the clamp is inactive.
// ---------------------------------------------------------------------------

test('computeReelBeats: hookStart is clamped to the guard (0.12) for a 6s clip', () => {
  // 6 * 0.02 = 0.12, which is less than 0.3 → clamp is active
  const b = computeReelBeats(6);
  assert.equal(b.hookStart, 0.12);
  // The raw 0.12 < 0.30 guard so Math.min picks 0.12.
});

test('computeReelBeats: hookStart equals the guard (0.3) once D*0.02 >= 0.3 (D >= 15s)', () => {
  // At exactly 15s: 15 * 0.02 = 0.3 → Math.min(0.3, 0.3) = 0.3 (clamp active but at boundary)
  const b15 = computeReelBeats(15);
  assert.equal(b15.hookStart, 0.3);

  // At 20s: 20 * 0.02 = 0.4 → Math.min(0.3, 0.4) = 0.3 (clamp is the binding constraint)
  const b20 = computeReelBeats(20);
  assert.equal(b20.hookStart, 0.3);
});
