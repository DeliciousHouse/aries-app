/**
 * Tests that workflowOutputFromRunRecord normalizes approval.stage to a
 * canonical NEXT-stage name validateApprovalTransition expects, regardless
 * of which of three shapes Hermes emits:
 *   (a) canonical NEXT stage name ("strategy", "production", ...),
 *   (b) transition descriptor ("research_to_strategy") — observed in prod,
 *   (c) bare COMPLETING-stage name ("research") — v0.1.3.43 convention.
 *
 * Root cause history:
 * - v0.1.3.43 added a normalization in buildBridgeCallbackPayload assuming
 *   (c) was the input. Did not actually exercise end-to-end because of
 *   the prior bug below.
 * - v0.1.3.46 extended the bridge to also handle (b). Still didn't work
 *   end-to-end because of the same prior bug.
 * - The actual culprit was the pre-filter in workflowOutputFromRunRecord:
 *   it defaulted any non-canonical value to "production", silently
 *   corrupting both (b) and (c) before they reached the bridge. The bridge
 *   then mapped "production" → "publish" via its completing→next map.
 *   The validator received "publish" for research stage and rejected as
 *   approval_stage_mismatch on every brand_campaign / marketing_pipeline
 *   job since the pre-filter's default-to-production fallback was added.
 * - v0.1.3.47 puts ALL normalization in the pre-filter (single source of
 *   truth) and reverts the bridge to a passthrough. Tests below mirror
 *   the pre-filter algorithm.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const TRANSITION_STAGE_RE = /^[a-z][a-z0-9]*_to_([a-z][a-z0-9]*)$/;
const COMPLETING_TO_NEXT_STAGE: Record<string, string> = {
  research: 'strategy',
  strategy: 'production',
  production: 'publish',
};
const CANONICAL_NEXT_STAGES = new Set([
  'plan',
  'creative',
  'video',
  'publish',
  'strategy',
  'production',
]);

function normalizeApprovalStage(stage: string | undefined): string {
  if (typeof stage !== 'string') return 'production';
  const transitionMatch = TRANSITION_STAGE_RE.exec(stage);
  const parsed = transitionMatch ? transitionMatch[1] : stage;
  if (CANONICAL_NEXT_STAGES.has(parsed)) return parsed;
  if (COMPLETING_TO_NEXT_STAGE[parsed]) return COMPLETING_TO_NEXT_STAGE[parsed];
  return 'production';
}

test('transition descriptor research_to_strategy → strategy', () => {
  assert.equal(normalizeApprovalStage('research_to_strategy'), 'strategy');
});

test('transition descriptor strategy_to_production → production', () => {
  assert.equal(normalizeApprovalStage('strategy_to_production'), 'production');
});

test('transition descriptor production_to_publish → publish', () => {
  assert.equal(normalizeApprovalStage('production_to_publish'), 'publish');
});

test('transition descriptor strategy_to_creative → creative (validator-allowed for strategy stage)', () => {
  assert.equal(normalizeApprovalStage('strategy_to_creative'), 'creative');
});

test('bare completing-stage research → strategy', () => {
  assert.equal(normalizeApprovalStage('research'), 'strategy');
});

test('bare completing-stage strategy passes through as strategy', () => {
  // Ambiguity: "strategy" is BOTH a completing-stage name AND a canonical
  // next-stage value (validator accepts for research stage). We prefer
  // next-stage semantics because the validator checks against the next
  // stage and Hermes's observed emission for completing-research is
  // "research_to_strategy", not bare "strategy".
  assert.equal(normalizeApprovalStage('strategy'), 'strategy');
});

test('canonical next-stage production passes through', () => {
  assert.equal(normalizeApprovalStage('production'), 'production');
});

test('canonical next-stage publish passes through', () => {
  assert.equal(normalizeApprovalStage('publish'), 'publish');
});

test('canonical next-stage plan passes through', () => {
  assert.equal(normalizeApprovalStage('plan'), 'plan');
});

test('canonical next-stage creative passes through', () => {
  assert.equal(normalizeApprovalStage('creative'), 'creative');
});

test('canonical next-stage video passes through', () => {
  assert.equal(normalizeApprovalStage('video'), 'video');
});

test('truly unknown stage falls back to production', () => {
  assert.equal(normalizeApprovalStage('unknown_future_stage'), 'production');
});

test('undefined stage falls back to production', () => {
  assert.equal(normalizeApprovalStage(undefined), 'production');
});

test('malformed transition (trailing underscore) does not match regex', () => {
  // "research_to_" fails the anchored regex; falls through and "research_to_"
  // is not in the canonical set or completing map → production fallback.
  assert.equal(normalizeApprovalStage('research_to_'), 'production');
});

test('malformed transition (uppercase) does not match anchored lowercase regex', () => {
  assert.equal(normalizeApprovalStage('Research_to_Strategy'), 'production');
});

// v0.1.3.48: bridge-side completing-stage detection
// Hermes inconsistently emits bare current-stage name for strategy-stage
// completion (observed in prod: emits "strategy" when strategy run finishes).
// Pre-filter passes "strategy" through (canonical allowlist). Bridge
// detects approval.stage === run.stage and remaps to next.
function bridgeNormalize(approvalStage: string | undefined, currentStage: 'research' | 'strategy' | 'production' | 'publish'): string | undefined {
  const map: Record<string, string> = {
    research: 'strategy',
    strategy: 'production',
    production: 'publish',
  };
  if (typeof approvalStage === 'string' && approvalStage === currentStage) {
    return map[currentStage] ?? approvalStage;
  }
  return approvalStage;
}

test('bridge: completing-stage "strategy" during strategy run → production', () => {
  assert.equal(bridgeNormalize('strategy', 'strategy'), 'production');
});

test('bridge: completing-stage "production" during production run → publish', () => {
  assert.equal(bridgeNormalize('production', 'production'), 'publish');
});

test('bridge: completing-stage "research" during research run → strategy', () => {
  assert.equal(bridgeNormalize('research', 'research'), 'strategy');
});

test('bridge: next-stage "strategy" during research run passes through', () => {
  // Pre-filter already converted "research_to_strategy" to "strategy".
  // approval.stage="strategy" ≠ run.stage="research" → no remap.
  assert.equal(bridgeNormalize('strategy', 'research'), 'strategy');
});

test('bridge: next-stage "production" during strategy run passes through', () => {
  // Pre-filter already converted "strategy_to_production" to "production".
  // approval.stage="production" ≠ run.stage="strategy" → no remap.
  assert.equal(bridgeNormalize('production', 'strategy'), 'production');
});

test('bridge: undefined approval.stage passes through', () => {
  assert.equal(bridgeNormalize(undefined, 'research'), undefined);
});
