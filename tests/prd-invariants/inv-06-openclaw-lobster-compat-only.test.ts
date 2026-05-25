// PRD §20 invariant 6:
//   "Legacy OpenClaw/Lobster behavior is compatibility-only unless explicitly
//    selected."
//
// Operationalized as:
//
// (a) No backend/lib code path may read an OPENCLAW_* env var at runtime.  The
//     legacy OpenClaw orchestrator has been replaced by the Hermes execution
//     port; any new OPENCLAW_* read would be a regression.
//
// (b) "Lobster" persists only as filesystem cache directory naming on disk for
//     pre-rename runtime artifacts.  We allowlist the known compat references
//     (artifact-store / artifact-collector / publish-review) and assert no new
//     ones appear elsewhere in backend/.

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
    `OPENCLAW_* env vars are legacy and must not be read at runtime.  Violations:\n${all.join('\n')}`,
  );
});

// Allowlist of files where "lobster-*-cache" appears as a *filesystem cache
// directory name* for backward-compat with pre-rename runtime artifacts.
// These are not active product code paths — they are compat aliases that
// resolve cache directories on disk.  The PRD treats this naming as
// compatibility-only.  If you add a new file with "lobster" in it, change the
// PRD §20 invariant first.
const LOBSTER_COMPAT_ALLOWLIST = new Set<string>([
  // Filesystem cache directory naming for pre-rename runtime artifacts.
  'backend/marketing/artifact-store.ts',
  'backend/marketing/artifact-collector.ts',
  'backend/marketing/publish-review.ts',
  'backend/marketing/jobs-status.ts',
  // Reads legacy `lobster_resume_token*` fields from old approval JSON on
  // disk so pre-rename approvals still load.  Approvals are read-mostly so
  // these fields will eventually age out; until then, defensive reads keep
  // the migration backward-compatible.
  'backend/marketing/approval-store.ts',
  // `/host-lobster-output` host mount path for pre-rename asset ingest.
  'backend/marketing/asset-ingest.ts',
]);

test('"lobster" naming is contained to the compat-only filesystem cache modules', () => {
  const hits = scanForPattern(repoPath('backend'), /lobster/i);
  const violations = hits
    .map((line) => line.split(':')[0])
    .filter((file) => !LOBSTER_COMPAT_ALLOWLIST.has(file));
  const unique = [...new Set(violations)];
  assert.deepEqual(
    unique,
    [],
    `"lobster" is compat-only naming for pre-rename filesystem caches.  Unexpected references in:\n${unique.join('\n')}`,
  );
});
