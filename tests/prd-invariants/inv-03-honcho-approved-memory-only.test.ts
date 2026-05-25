// PRD §20 invariant 3:
//   "Honcho stores only approved durable memory; it does not replace Postgres."
//
// Operationalized as: backend/memory/write-events.ts is the single entry point
// for Honcho writes; it must (a) be gated by idempotency keys so replays are
// no-ops, and (b) expose explicit approval / denial recording functions so
// callers cannot bypass the approval semantics with a generic "write" helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile } from './_helpers';

const source = readRepoFile('backend/memory/write-events.ts');

test('honcho writes are gated by an idempotency-keys table', () => {
  assert.match(
    source,
    /honcho_write_idempotency_keys/,
    'backend/memory/write-events.ts must reference the honcho_write_idempotency_keys table so replayed approval events are no-ops',
  );
});

test('write-events surfaces approval and denial recording, not a generic write', () => {
  assert.match(source, /export\s+(?:async\s+)?function\s+recordApprovalEvent\b/);
  assert.match(source, /export\s+(?:async\s+)?function\s+recordDenialEvent\b/);
});

test('write-events does not export a generic unguarded honcho write helper', () => {
  const banned = /export\s+(?:async\s+)?function\s+(writeHoncho|appendHonchoRaw|honchoWriteRaw)\b/;
  assert.ok(
    !banned.test(source),
    'no generic unguarded honcho writer may be exported — every write must travel through an approval-bearing function',
  );
});
