// PRD §20 invariant 7:
//   "Publishing requires approval."
//
// Operationalized as: the marketing state machine in
// backend/marketing/runtime-state.ts must include `approval_required` as a
// distinct state, and the approval record shape must have an `'approved'`
// status that gates downstream publish operations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile } from './_helpers';

test('marketing job state machine includes approval_required as a distinct state', () => {
  const source = readRepoFile('backend/marketing/runtime-state.ts');
  assert.match(
    source,
    /export\s+type\s+MarketingJobState\s*=[^;]*\bapproval_required\b/,
    "MarketingJobState union must include 'approval_required'",
  );
});

test('approval record has explicit approved | denied | cleared statuses', () => {
  const source = readRepoFile('backend/marketing/runtime-state.ts');
  assert.match(
    source,
    /status\s*:\s*['"]requested['"]\s*\|\s*['"]approved['"]\s*\|\s*['"]denied['"]\s*\|\s*['"]cleared['"]/,
    'approval status union must include approved/denied/cleared so publish-gating logic is explicit',
  );
});

test('publishingRequested flag exists on the orchestrator surface', () => {
  const source = readRepoFile('backend/marketing/orchestrator.ts');
  assert.match(
    source,
    /publishingRequested/,
    'orchestrator must expose publishingRequested so callers cannot publish implicitly',
  );
});
