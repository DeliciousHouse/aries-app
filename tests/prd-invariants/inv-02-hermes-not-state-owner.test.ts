// PRD §20 invariant 2:
//   "Hermes executes bounded tasks and returns structured results; Hermes does
//    not own Aries product state."
//
// Operationalized as: dashboard read paths (runtime-views, runtime-state,
// dashboard-content) must source state from Aries-owned storage — Postgres
// (lib/db), runtime JSON files, and approval-store — never by calling the
// Hermes gateway client.  Hermes touches happen through the execution-port
// seam at submit/orchestrator level, not on read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile } from './_helpers';

const READ_PATH_FILES = [
  'backend/marketing/runtime-views.ts',
  'backend/marketing/runtime-state.ts',
  'backend/marketing/dashboard-content.ts',
];

// Forbidden import patterns: anything that pulls in a Hermes-specific client
// from a dashboard read path.  Allowed: type-only references to execution-port
// shapes (which are vendor-neutral by design).
const HERMES_CLIENT_IMPORT = /from\s+['"](?:[^'"]*\/)?(execution\/providers\/hermes|hermes-client|hermes-gateway)/;

for (const file of READ_PATH_FILES) {
  test(`${file} does not import a Hermes-specific client`, () => {
    const source = readRepoFile(file);
    assert.ok(
      !HERMES_CLIENT_IMPORT.test(source),
      `${file} reads dashboard state and must not import a Hermes-specific client; product state lives in Aries-owned storage`,
    );
  });
}
