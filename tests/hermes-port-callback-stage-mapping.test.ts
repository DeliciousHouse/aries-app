/**
 * Tests that buildBridgeCallbackPayload normalizes approval.stage to the
 * NEXT stage that validateApprovalTransition expects, regardless of which
 * of three shapes Hermes emits:
 *   (a) the COMPLETING stage on its own ("research") — v0.1.3.43 convention,
 *   (b) a transition descriptor ("research_to_strategy") — observed in prod,
 *   (c) the bare NEXT stage on its own ("strategy") — future protocol.
 *
 * Root cause history:
 * - v0.1.3.43 handled (a). Validator now received "strategy" for research-done.
 * - v0.1.3.45 reproduced a stuck campaign: Hermes was actually emitting (b),
 *   the transition descriptor "research_to_strategy". The map only knew the
 *   bare-completing form, so the transition descriptor fell through unchanged
 *   and the validator rejected with approval_stage_mismatch. Adding the
 *   "X_to_Y" parse closes the gap so all three shapes converge on the next
 *   stage the validator wants.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const COMPLETING_TO_NEXT_STAGE: Record<string, string> = {
  research: 'strategy',
  strategy: 'production',
  production: 'publish',
};
const TRANSITION_STAGE_RE = /^[a-z][a-z0-9]*_to_([a-z][a-z0-9]*)$/;

function normalizeApprovalStage(stage: string | undefined): string | undefined {
  if (stage == null) return stage;
  const transitionMatch = TRANSITION_STAGE_RE.exec(stage);
  if (transitionMatch) {
    return transitionMatch[1];
  }
  return COMPLETING_TO_NEXT_STAGE[stage] ?? stage;
}

test('research completing-stage maps to strategy next-stage', () => {
  assert.equal(normalizeApprovalStage('research'), 'strategy');
});

test('strategy completing-stage maps to production next-stage', () => {
  assert.equal(normalizeApprovalStage('strategy'), 'production');
});

test('production completing-stage maps to publish next-stage', () => {
  assert.equal(normalizeApprovalStage('production'), 'publish');
});

test('publish (terminal) passes through unchanged', () => {
  assert.equal(normalizeApprovalStage('publish'), 'publish');
});

test('transition descriptor research_to_strategy → strategy', () => {
  assert.equal(normalizeApprovalStage('research_to_strategy'), 'strategy');
});

test('transition descriptor strategy_to_production → production', () => {
  assert.equal(normalizeApprovalStage('strategy_to_production'), 'production');
});

test('transition descriptor production_to_publish → publish', () => {
  assert.equal(normalizeApprovalStage('production_to_publish'), 'publish');
});

test('transition descriptor production_to_creative → creative (validator-allowed)', () => {
  assert.equal(normalizeApprovalStage('strategy_to_creative'), 'creative');
});

test('unknown stage passes through unchanged (defensive)', () => {
  assert.equal(normalizeApprovalStage('unknown_future_stage'), 'unknown_future_stage');
});

test('undefined stage passes through as undefined', () => {
  assert.equal(normalizeApprovalStage(undefined), undefined);
});

test('malformed transition (trailing underscore) does not crash', () => {
  assert.equal(normalizeApprovalStage('research_to_'), 'research_to_');
});

test('malformed transition (uppercase) does not match transition regex', () => {
  // Defensive: anchored lowercase regex protects against arbitrary input.
  assert.equal(normalizeApprovalStage('Research_to_Strategy'), 'Research_to_Strategy');
});
