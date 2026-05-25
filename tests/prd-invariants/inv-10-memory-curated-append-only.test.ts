// PRD §20 invariant 10:
//   "Memory is curated, append-only, provenance-bearing, and supersedable."
//
// Operationalized as: backend/memory/* must not issue UPDATE or DELETE
// statements against the honcho_* tables.  Supersession is modeled by
// appending a new event that references the prior one, not by mutating the
// existing row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanForPattern, repoPath } from './_helpers';

test('backend/memory issues no UPDATE statements against honcho_ tables', () => {
  const hits = scanForPattern(
    repoPath('backend/memory'),
    /UPDATE\s+honcho_/i,
  );
  assert.deepEqual(
    hits,
    [],
    `memory writes must be append-only; UPDATE against honcho_* tables found:\n${hits.join('\n')}`,
  );
});

test('backend/memory issues no DELETE statements against honcho_ tables', () => {
  const hits = scanForPattern(
    repoPath('backend/memory'),
    /DELETE\s+FROM\s+honcho_/i,
  );
  assert.deepEqual(
    hits,
    [],
    `memory writes must be append-only; DELETE against honcho_* tables found:\n${hits.join('\n')}`,
  );
});

test('backend/memory uses INSERT for the idempotency-keys table (positive control)', () => {
  const hits = scanForPattern(
    repoPath('backend/memory'),
    /INSERT INTO honcho_write_idempotency_keys/,
  );
  assert.ok(
    hits.length >= 1,
    'expected at least one INSERT into honcho_write_idempotency_keys — positive control that the append-only path is exercised',
  );
});
