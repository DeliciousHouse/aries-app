// PRD §20 invariant 1:
//   "Aries owns tenant boundaries, canonical state, approvals, audit, and
//    workflow policy."
//
// Operationalized as: tenant resolution lives in `lib/tenant-context.ts` and is
// the only published surface that produces a `TenantContext`.  Route handlers
// must reach for it (directly or via a wrapper) rather than reconstructing
// tenant identity from request inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile, scanForPattern, repoPath } from './_helpers';

test('lib/tenant-context.ts exports getTenantContext as the canonical resolver', () => {
  const source = readRepoFile('lib/tenant-context.ts');
  assert.match(
    source,
    /export\s+(?:async\s+)?function\s+getTenantContext\b/,
    'lib/tenant-context.ts must export getTenantContext()',
  );
  assert.match(
    source,
    /TenantContextError/,
    'tenant-context module must surface a typed TenantContextError',
  );
});

test('app/api/ has multiple callers of getTenantContext (tenant resolution is centralized)', () => {
  const hits = scanForPattern(repoPath('app/api'), /\bgetTenantContext\s*\(/);
  assert.ok(
    hits.length >= 10,
    `expected at least 10 route handlers to call getTenantContext(); found ${hits.length}`,
  );
});
