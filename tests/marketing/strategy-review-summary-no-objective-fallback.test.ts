import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveStrategyReviewSummary } from '../../backend/marketing/workspace-views';

// REGRESSION (Copilot review on PR #485): the prior implementation fell back
// from campaign_plan.core_message to reviewPacket.objective for the Strategy
// Review header summary. An objective and a summary are structurally different
// fields — mapping one onto the other put the wrong text in the reviewer's
// face. These tests pin the new contract:
//   - core_message present → use it
//   - core_message missing → use the generic prompt copy
//   - objective alone (no core_message) → STILL the generic copy, never the
//     objective text

const GENERIC = 'Review the campaign proposal before creative production is treated as approved.';

test('deriveStrategyReviewSummary: returns core_message when present', () => {
  const summary = deriveStrategyReviewSummary({
    core_message: 'Aries AI owns the calm weekly social content operating system lane.',
  });
  assert.equal(
    summary,
    'Aries AI owns the calm weekly social content operating system lane.',
  );
});

test('deriveStrategyReviewSummary: returns generic copy when core_message is absent', () => {
  const summary = deriveStrategyReviewSummary({});
  assert.equal(summary, GENERIC);
});

test('deriveStrategyReviewSummary: returns generic copy when input is undefined', () => {
  const summary = deriveStrategyReviewSummary(undefined);
  assert.equal(summary, GENERIC);
});

test('deriveStrategyReviewSummary: returns generic copy when input is null', () => {
  const summary = deriveStrategyReviewSummary(null);
  assert.equal(summary, GENERIC);
});

test('deriveStrategyReviewSummary: core_message="" (empty string) falls through to generic, not the empty value', () => {
  const summary = deriveStrategyReviewSummary({ core_message: '' });
  assert.equal(summary, GENERIC);
});

test('deriveStrategyReviewSummary: core_message of whitespace-only falls through to generic', () => {
  const summary = deriveStrategyReviewSummary({ core_message: '   ' });
  assert.equal(summary, GENERIC);
});

test('deriveStrategyReviewSummary: objective alone is NOT used as a fallback (the bug we fixed)', () => {
  // Construct the exact happy-path-but-incomplete shape: campaign_plan present,
  // core_message blank, objective populated. The old code would surface the
  // objective text here. The new code MUST return the generic prompt instead.
  const summary = deriveStrategyReviewSummary({
    objective: 'Drive 50 enterprise demo bookings in Q3.',
  });
  assert.equal(summary, GENERIC, 'objective text must never reach the Strategy Review summary');
  assert.ok(
    !summary.includes('Drive 50 enterprise demo bookings'),
    'objective text must not leak into the summary',
  );
});

