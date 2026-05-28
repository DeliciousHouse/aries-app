// PRD §20 invariant 6:
//   "OpenClaw/Lobster has been fully removed. Hermes is the only execution
//    provider."
//
// Operationalized as:
//
// (a) No backend/lib code path may read an OPENCLAW_* env var at runtime.
//
// (b) No active Lobster code paths remain. The only remaining references are
//     defensive reads of pre-migration DB field names in approval-store.ts
//     (lobster_resume_token* columns that exist on old approval rows). These
//     cannot be removed without a DB migration (Cut 3 scope). All other
//     lobster/openclaw strings must be absent from backend/ and lib/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanForPattern, repoPath } from './_helpers';

test('no backend or lib code reads OPENCLAW_* env vars at runtime', () => {
  const backendHits = scanForPattern(repoPath('backend'), /process\.env\.OPENCLAW_/);
  const libHits = scanForPattern(repoPath('lib'), /process\.env\.OPENCLAW_/);
  const all = [...backendHits, ...libHits];
  assert.deepEqual(
    all,
    [],
    `OPENCLAW_* env vars must not be read at runtime.  Violations:\n${all.join('\n')}`,
  );
});

// approval-store.ts retains defensive reads of pre-migration DB column names
// (lobster_resume_token, lobster_resume_token_fingerprint, lobster_resume_state_keys).
// These are JSON field names from rows written before the Hermes cutover and
// can only be removed via a DB migration (tracked separately). All other
// lobster/openclaw strings in backend/ must be absent.
const DB_COMPAT_ALLOWLIST = new Set<string>([
  'backend/marketing/approval-store.ts',
]);

test('"lobster"/"openclaw" naming is absent from backend/ except pre-migration DB field compat', () => {
  const hits = scanForPattern(repoPath('backend'), /lobster|openclaw/i);
  const violations = hits
    .map((line) => line.split(':')[0])
    .filter((file) => !DB_COMPAT_ALLOWLIST.has(file));
  const unique = [...new Set(violations)];
  assert.deepEqual(
    unique,
    [],
    `"lobster"/"openclaw" must not appear in backend/ outside the DB compat shim.  Unexpected references in:\n${unique.join('\n')}`,
  );
});

test('no lobster/openclaw references in lib/', () => {
  const hits = scanForPattern(repoPath('lib'), /lobster|openclaw/i);
  assert.deepEqual(
    hits,
    [],
    `"lobster"/"openclaw" must not appear in lib/ source.  Violations:\n${hits.join('\n')}`,
  );
});
