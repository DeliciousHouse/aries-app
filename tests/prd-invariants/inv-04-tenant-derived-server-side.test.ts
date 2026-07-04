// PRD §20 invariant 4:
//   "Tenant IDs are derived server-side; clients and callbacks do not decide
//    tenant access."
//
// Operationalized as: no app/api/ route handler may read a tenant identifier
// directly off the request body or query without immediately overriding it
// from server-side resolution.  Hermes callbacks are the documented exception
// because they receive an aries_run_id whose tenant is looked up server-side
// via the execution_runs table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanForPattern, repoPath, rel } from './_helpers';

// Patterns that indicate a route handler is reading tenant identity directly
// from client input.  Anything matching these is a candidate violation.
const CLIENT_TENANT_READ = /body\.(tenantId|tenant_id|organizationId|organization_id)\b/;

// Files allowed to mention these expressions because they are documented
// exceptions or internal-only routes that re-derive tenant via execution_runs
// / aries_run_id lookup.  Update the PRD before adding to this list.
const ALLOWLIST = new Set<string>([
  // Hermes run callback maps aries_run_id → tenant_id via execution_runs row
  'app/api/internal/hermes/runs/route.ts',
  // Internal aries-research callback resolves tenant via aries_research_jobs row
  'app/api/internal/aries-research/callback/route.ts',
  // Internal scheduled-posts-worker sidecar endpoint.  Guarded by
  // verifyInternalCallbackRequest (INTERNAL_API_SECRET) at the top of the
  // handler.  Body-supplied tenant_id is acceptable here because the trusted
  // server-side sidecar is the only legitimate caller; the secret-bearer is
  // the tenant authority.
  'app/api/internal/publishing/scheduled-dispatch/route.ts',
  // Internal weekly-trigger-worker sidecar endpoint.  Same justification as the
  // scheduled-dispatch route: guarded by verifyInternalCallbackRequest
  // (INTERNAL_API_SECRET); the only legitimate caller is the trusted server-side
  // weekly-job-trigger worker, and the secret-bearer is the tenant authority.
  'app/api/internal/marketing/weekly-trigger/route.ts',
  // Workspace switch (multi-workspace plan Phase 3).  The body-supplied
  // organizationId is the SWITCH TARGET, not the acting tenant: the request
  // acts as the session user, and switchActiveWorkspace validates the target
  // against the caller's own organization_memberships (status='active') inside
  // its transaction — a non-member gets 403, so the client cannot decide tenant
  // access.  This is resource selection by id (validated server-side), not
  // tenant derivation from client input.  Endpoint 404s flag-OFF.
  'app/api/tenant/workspace/switch/route.ts',
]);

test('no app/api route reads tenant id directly from the request body', () => {
  const hits = scanForPattern(repoPath('app/api'), CLIENT_TENANT_READ);
  const violations = hits.filter((line) => {
    const file = line.split(':')[0];
    return !ALLOWLIST.has(file);
  });
  assert.deepEqual(
    violations,
    [],
    `tenant identity must be derived server-side (getTenantContext / execution_runs lookup).  Violations:\n${violations.join('\n')}`,
  );
});

test('tenant-context module is reachable from app/api', () => {
  const hits = scanForPattern(repoPath('app/api'), /from\s+['"]@\/lib\/tenant-context['"]/);
  assert.ok(hits.length >= 1, 'expected at least one app/api file to import @/lib/tenant-context');
});
