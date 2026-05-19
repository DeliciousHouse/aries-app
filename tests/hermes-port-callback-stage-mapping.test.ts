/**
 * Tests that buildBridgeCallbackPayload normalizes approval.stage from the
 * completing-stage convention Hermes uses to the next-stage convention
 * validateApprovalTransition expects.
 *
 * Root cause: Hermes emits approval.stage = "research" when research finishes
 * and pauses for strategy approval. Aries' validator expects approval.stage =
 * "strategy" (the gate to open). Without normalization every brand_campaign
 * job hits approval_stage_mismatch and the run_id is never stored, leaving
 * the run to be reaped as stale.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const COMPLETING_TO_NEXT_STAGE: Record<string, string> = {
  research: 'strategy',
  strategy: 'production',
  production: 'publish',
};

function normalizeApprovalStage(stage: string | undefined): string | undefined {
  if (stage == null) return stage;
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

test('unknown stage passes through unchanged (defensive)', () => {
  assert.equal(normalizeApprovalStage('unknown_future_stage'), 'unknown_future_stage');
});

test('undefined stage passes through as undefined', () => {
  assert.equal(normalizeApprovalStage(undefined), undefined);
});
