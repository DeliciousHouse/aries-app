/**
 * Multi-workspace mutation guard — SERVER half: the typed error → HTTP mapping
 * (plan Decision 2a, Phase 3; eng finding 12 / S2 fail-closed).
 *
 * The guard inside getTenantContext() throws a typed WorkspaceMismatchError; the
 * HTTP layer (lib/tenant-context-http.ts::workspaceMismatchResponse) is the ONE
 * place that shape is turned into `409 workspace_mismatch`. Both the ~43 wrapper
 * routes and the ~9 raw getTenantContext() routes route through this shape, so
 * this file pins:
 *   - the two guard reasons (stale pointer vs claims-fallback fail-closed) both
 *     map to 409 (a fail-closed write must NOT slip through as a non-conflict);
 *   - the response body is frontend-safe (no token, no internal state), carries
 *     the two workspace ids, and is keyed so the client interlock recognizes it;
 *   - non-mismatch errors return null so callers keep their own error handling
 *     (a mismatch is never conflated with a 403/last_admin/etc).
 *
 * getTenantContext() itself pulls next/headers + auth() + a live pool, so it is
 * driven end-to-end only in the rendered-QA success bar; the guard *decision*
 * branches are asserted at their exported seams (this file + the client half).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkspaceMismatchError } from '../../lib/tenant-context';
import { workspaceMismatchResponse } from '../../lib/tenant-context-http';

test('workspaceMismatchResponse maps a stale-pointer mismatch to 409 with a frontend-safe body', async () => {
  const error = new WorkspaceMismatchError('workspace_mismatch', '9', '7');
  const response = workspaceMismatchResponse(error);
  assert.ok(response, 'a WorkspaceMismatchError must map to a Response');
  assert.equal(response!.status, 409, 'the mutation guard is a 409, never a 403');
  assert.equal(response!.headers.get('content-type'), 'application/json');

  const body = (await response!.json()) as Record<string, unknown>;
  // Keyed both ways so the client interlock reader (readWorkspaceMismatchBody)
  // recognizes it via code OR reason.
  assert.equal(body.reason, 'workspace_mismatch');
  assert.equal(body.code, 'workspace_mismatch');
  assert.equal(body.active_workspace_id, '9');
  assert.equal(body.requested_workspace_id, '7');
  assert.equal(typeof body.message, 'string');

  // Frontend-safe: no token / raw error / internal state leaked.
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /token|secret|password|stack|INTERNAL/i);
});

test('claims-fallback fail-closed (workspace_unverifiable) ALSO maps to 409 (a write must fail closed, not slip through)', async () => {
  // Eng finding 12/S2: when tenant resolution used the stale-claims fallback,
  // membership cannot be verified, so a header-bearing mutation fails closed.
  const error = new WorkspaceMismatchError('workspace_unverifiable', '9', '7');
  assert.equal(error.reason, 'workspace_unverifiable');
  // The unverifiable message must not claim a concrete active workspace the way
  // the stale-pointer message does — it says membership could not be verified.
  assert.match(error.message, /could not be verified|session-claims fallback/i);

  const response = workspaceMismatchResponse(error);
  assert.ok(response);
  assert.equal(response!.status, 409, 'fail-closed must be a 409, never a 200/allow-through');
  const body = (await response!.json()) as Record<string, unknown>;
  // It maps to the same client-facing shape (the interlock treats both reasons
  // identically — the tab is stale either way).
  assert.equal(body.code, 'workspace_mismatch');
  assert.equal(body.requested_workspace_id, '7');
});

test('WorkspaceMismatchError carries both workspace ids and the reason discriminant', () => {
  const stale = new WorkspaceMismatchError('workspace_mismatch', '9', '7');
  assert.equal(stale.name, 'WorkspaceMismatchError');
  assert.equal(stale.activeWorkspaceId, '9');
  assert.equal(stale.requestedWorkspaceId, '7');
  assert.equal(stale.reason, 'workspace_mismatch');
  assert.match(stale.message, /7/);
  assert.match(stale.message, /9/);
  assert.ok(stale instanceof Error);
});

test('workspaceMismatchResponse returns null for non-mismatch errors (never conflates with 403/last_admin/etc)', () => {
  assert.equal(workspaceMismatchResponse(new Error('boom')), null);
  assert.equal(workspaceMismatchResponse(new TypeError('nope')), null);
  assert.equal(workspaceMismatchResponse({ reason: 'workspace_mismatch' }), null,
    'a plain object that merely looks like a mismatch is NOT mapped — only the typed error is');
  assert.equal(workspaceMismatchResponse(null), null);
  assert.equal(workspaceMismatchResponse(undefined), null);
});

test('the raw getTenantContext() mutating routes import the 409 mapper in their catch (guard reaches the direct-call routes)', async () => {
  // The ~9 routes that call getTenantContext() directly (not via the wrapper)
  // must translate the guard throw into the 409 themselves — otherwise a
  // mismatch on exactly the team-management surface multi-workspace modifies
  // would surface as a generic 403 and never reach the interlock. Assert the
  // representative team-management route wires the mapper.
  const { readFileSync } = await import('node:fs');
  const { repoPath } = await import('../prd-invariants/_helpers');

  const profileRoute = readFileSync(
    repoPath('app/api/tenant/profiles/[userId]/route.ts'),
    'utf8',
  );
  // Both mutating handlers (PATCH role-change, DELETE remove/self-leave) must
  // map the mismatch before their generic 403.
  const patchIdx = profileRoute.indexOf('export async function PATCH');
  const deleteIdx = profileRoute.indexOf('export async function DELETE');
  assert.ok(patchIdx >= 0 && deleteIdx >= 0, 'PATCH + DELETE handlers must exist');
  for (const [name, start] of [['PATCH', patchIdx], ['DELETE', deleteIdx]] as const) {
    const body = profileRoute.slice(start, profileRoute.indexOf('\n}\n', start) + 3 || undefined);
    assert.match(
      body,
      /workspaceMismatchResponse\s*\(/,
      `${name} must route a WorkspaceMismatchError into the 409 mapper before its generic 403`,
    );
  }
});
