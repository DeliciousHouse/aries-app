// PRD §20 invariant 15:
//   "Product behavior must depend on capability ports and contracts, not
//    hard-coded AI vendor assumptions."
//
// Operationalized as: backend/marketing/* must depend on the execution-port
// seam (backend/marketing/execution-port.ts, backend/execution/provider-factory)
// rather than reaching directly into vendor-specific provider implementations.
// One scoped exception: the dedicated Hermes adapter file
// backend/marketing/ports/hermes.ts is the seam itself and is allowed to
// know vendor specifics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanForPattern, repoPath, rel } from './_helpers';

const VENDOR_PROVIDER_IMPORT =
  /from\s+['"][^'"]*\/backend\/execution\/providers\/hermes[^'"]*['"]/;

const ALLOWED_FILES = new Set<string>([
  // Provider factory legitimately wires up the Hermes adapter.
  'backend/execution/provider-factory.ts',
  // The marketing-side Hermes port is the seam itself.
  'backend/marketing/ports/hermes.ts',
]);

test('backend/marketing avoids direct imports of execution/providers/hermes', () => {
  const hits = scanForPattern(repoPath('backend/marketing'), VENDOR_PROVIDER_IMPORT);
  const violations = hits.filter((line) => {
    const file = line.split(':')[0];
    return !ALLOWED_FILES.has(file);
  });
  assert.deepEqual(
    violations,
    [],
    `marketing code must depend on the execution-port seam, not the vendor adapter.  Violations:\n${violations.join('\n')}`,
  );
});

test('execution-port abstraction file exists', () => {
  const portHits = scanForPattern(
    repoPath('backend/marketing'),
    /execution-port/,
  );
  assert.ok(
    portHits.length >= 1,
    'expected backend/marketing/execution-port.ts (or references to it) to define the vendor-neutral seam',
  );
});
