import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultStageSummary } from '../../backend/marketing/jobs-status';
import type { MarketingStageError } from '../../backend/marketing/runtime-state';

// REGRESSION (v0.1.12.2 slice A QA on mkt_2088bccf): the Runtime Status page
// showed "Production failed" as the label AND "Production assets are ready."
// as the description on the same card. Root cause: stage-card summary
// fallbacks were hardcoded happy-path strings used regardless of status.
// Fix: defaultStageSummary returns status-aware copy.

test('defaultStageSummary: production + failed never claims assets are ready', () => {
  const summary = defaultStageSummary('production', 'failed', []);
  assert.ok(!summary.toLowerCase().includes('are ready'), `must not claim ready: ${summary}`);
  assert.ok(summary.toLowerCase().includes('failed'), `must surface failure: ${summary}`);
});

test('defaultStageSummary: production + failed surfaces last error message verbatim', () => {
  const errors: MarketingStageError[] = [
    { stage: 'production', message: 'first', code: 'hermes_error', at: '2026-05-26T17:00:00Z' },
    { stage: 'production', message: 'Hermes gateway timeout after 600000ms.', code: 'hermes_error', at: '2026-05-26T17:10:00Z' },
  ];
  const summary = defaultStageSummary('production', 'failed', errors);
  assert.ok(
    summary.includes('Hermes gateway timeout after 600000ms.'),
    `must include latest error message: ${summary}`,
  );
});

test('defaultStageSummary: strategy + failed never claims strategy is ready', () => {
  const summary = defaultStageSummary('strategy', 'failed', []);
  assert.ok(!summary.toLowerCase().includes('is ready'), `must not claim ready: ${summary}`);
  assert.ok(summary.toLowerCase().includes('failed'), `must surface failure: ${summary}`);
});

test('defaultStageSummary: research + failed never claims research completed', () => {
  const summary = defaultStageSummary('research', 'failed', []);
  assert.ok(!summary.toLowerCase().includes('completed'), `must not claim completed: ${summary}`);
  assert.ok(summary.toLowerCase().includes('failed'), `must surface failure: ${summary}`);
});

test('defaultStageSummary: publish + failed never says publishing happen in the final stage', () => {
  const summary = defaultStageSummary('publish', 'failed', []);
  // Generic happy-path "Launch review and publishing happen in the final stage."
  // is fine for pending, but NOT for failed.
  assert.ok(!summary.toLowerCase().includes('happen in the final stage'), `must not show pending copy: ${summary}`);
  assert.ok(summary.toLowerCase().includes('failed'), `must surface failure: ${summary}`);
});

test('defaultStageSummary: production + completed returns happy-path text', () => {
  const summary = defaultStageSummary('production', 'completed', []);
  assert.equal(summary, 'Production assets are ready.');
});

test('defaultStageSummary: strategy + completed returns happy-path text', () => {
  const summary = defaultStageSummary('strategy', 'completed', []);
  assert.equal(summary, 'Campaign strategy is ready.');
});

test('defaultStageSummary: research + completed returns happy-path text', () => {
  const summary = defaultStageSummary('research', 'completed', []);
  assert.equal(summary, 'Competitive research completed.');
});

test('defaultStageSummary: production + running surfaces work-in-progress', () => {
  const summary = defaultStageSummary('production', 'running', []);
  assert.ok(summary.toLowerCase().includes('running'), `must show progress: ${summary}`);
  assert.ok(!summary.toLowerCase().includes('are ready'), `must not claim ready while running: ${summary}`);
});

test('defaultStageSummary: production + in_progress surfaces work-in-progress', () => {
  const summary = defaultStageSummary('production', 'in_progress', []);
  assert.ok(summary.toLowerCase().includes('running'), `must show progress: ${summary}`);
});

test('defaultStageSummary: production + pending surfaces not-started', () => {
  const summary = defaultStageSummary('production', 'pending', []);
  assert.ok(
    summary.toLowerCase().includes('not started') || summary.toLowerCase().includes('has not'),
    `must show not-started state: ${summary}`,
  );
  assert.ok(!summary.toLowerCase().includes('are ready'), `must not claim ready while pending: ${summary}`);
});

test('defaultStageSummary: empty status defaults safely (research not-started, not completed)', () => {
  const summary = defaultStageSummary('research', '', []);
  assert.ok(
    summary.toLowerCase().includes('not started') || summary.toLowerCase().includes('has not'),
    `empty status must default to not-started, not completed: ${summary}`,
  );
});

test('defaultStageSummary: failed + empty errors array still surfaces failure clearly', () => {
  const summary = defaultStageSummary('production', 'failed', []);
  // Must not be empty or "undefined"
  assert.ok(summary.length > 10, `must be non-trivially descriptive: ${summary}`);
  assert.ok(summary.toLowerCase().includes('failed'), `must surface failure even without error detail: ${summary}`);
});

test('defaultStageSummary: failed + last-error blank string falls back to generic failed copy', () => {
  const errors: MarketingStageError[] = [
    { stage: 'production', message: '   ', code: 'hermes_error', at: '2026-05-26T17:00:00Z' },
  ];
  const summary = defaultStageSummary('production', 'failed', errors);
  assert.ok(summary.toLowerCase().includes('failed'), `must show failure: ${summary}`);
  // Should NOT include the blank message — fallback copy should kick in
  assert.ok(!summary.includes('failed:   '), `blank-message error must not leak: ${summary}`);
});

test('defaultStageSummary: status case-insensitive (FAILED, Failed, failed)', () => {
  const lower = defaultStageSummary('production', 'failed', []);
  const upper = defaultStageSummary('production', 'FAILED', []);
  const mixed = defaultStageSummary('production', 'Failed', []);
  assert.equal(lower, upper);
  assert.equal(lower, mixed);
});
