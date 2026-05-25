// PRD §20 invariant 13:
//   "Workflow transitions must be explicit, auditable, and resumable where
//    designed."
//
// Operationalized as: the marketing job state machine is a closed union (no
// implicit "any string" state), and the orchestrator records resume state via
// the approval store so a callback replay can pick up where it left off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile } from './_helpers';

test('MarketingJobState is a closed string-literal union (no implicit states)', () => {
  const source = readRepoFile('backend/marketing/runtime-state.ts');
  const match = source.match(
    /export\s+type\s+MarketingJobState\s*=\s*([^;]+);/,
  );
  assert.ok(match, 'MarketingJobState type alias must exist');
  const body = match![1];
  // Each state must be a literal string (single-quoted), not `string`.
  assert.ok(
    !/\bstring\b/.test(body),
    "MarketingJobState may not widen to `string`; transitions must remain a closed union",
  );
  // Spot-check that key states are present.
  for (const required of ['queued', 'running', 'approval_required', 'completed', 'failed']) {
    assert.ok(
      new RegExp(`['"]${required}['"]`).test(body),
      `MarketingJobState must include '${required}'`,
    );
  }
});

test('orchestrator persists approval state through approval-store (resumability)', () => {
  const source = readRepoFile('backend/marketing/orchestrator.ts');
  assert.match(
    source,
    /approval-store|approvalStore|approval_store/,
    'orchestrator must persist approval records so a resumed run can read prior decisions',
  );
});

test('idempotency keys are computed for execution submissions (replay-safe)', () => {
  const source = readRepoFile('backend/marketing/orchestrator.ts');
  assert.match(
    source,
    /idempotency_key|idempotencyKey/,
    'orchestrator must pass an idempotency key on submission so replayed callbacks are safe',
  );
});
