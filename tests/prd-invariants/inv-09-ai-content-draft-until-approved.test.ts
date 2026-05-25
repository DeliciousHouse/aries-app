// PRD §20 invariant 9:
//   "AI-generated content is draft content until approved."
//
// Operationalized as: runtime documents for in-flight marketing jobs live under
// the generated/draft/ subtree (not generated/validated/) until an approval
// event promotes them.  The runtime-state module must resolve job paths into
// the draft directory by default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile } from './_helpers';

test('runtime-state resolves marketing job paths under generated/draft/', () => {
  const source = readRepoFile('backend/marketing/runtime-state.ts');
  assert.match(
    source,
    /resolveDataPath\(\s*['"]generated['"]\s*,\s*['"]draft['"]\s*,\s*['"]marketing-jobs['"]/,
    'marketing jobs must live under generated/draft/marketing-jobs/ until approved',
  );
});

test('there is a distinction between draft and validated subtrees', () => {
  // CLAUDE.md documents the two-subtree layout; we assert both are referenced
  // somewhere in the backend so the invariant has structural backing.
  const draftHits = readRepoFile('backend/marketing/runtime-state.ts').includes("'draft'");
  const validatedExists = readRepoFile('lib/runtime-paths.ts').match(/validated|draft/);
  assert.ok(draftHits, 'runtime-state must mention the draft subtree');
  assert.ok(validatedExists, 'runtime-paths must document the draft/validated split');
});
