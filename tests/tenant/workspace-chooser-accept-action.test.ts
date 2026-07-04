/**
 * Multi-workspace Phase 1 — chooser "Accept invite" action: security + the
 * KNOWN Phase-1 limitation (docs/plans/2026-07-03-multi-workspace-membership.md,
 * design spec "Zero-membership chooser is invite-aware"; eng finding 2 — the
 * resend gate moves to membership.status in Phase 2).
 *
 * The chooser cannot link the emailed (hashed) token, so its Accept action
 * re-mints the caller's own invitation via resendWorkspaceInvitation, then hands
 * off to /invite/accept. This file pins:
 *   (A) the security floor — resend is scoped to the SIGNED-IN account's own
 *       invited membership; a stranger's org id can never mint a token;
 *   (B) the honest Phase-1 boundary — resendWorkspaceInvitation resolves the
 *       user profile by the users.organization_id POINTER, not the membership
 *       org, so for the exact zero-membership case the chooser exists for it
 *       returns NOT-ok and the Accept button is presently a dead end
 *       (redirect ?error=invite_link). This is designed to flip to a real
 *       accept when Phase 2 re-scopes resend to (user_id, organization_id) /
 *       membership.status. Documented so nobody reads the green chooser page as
 *       proof the accept works end-to-end.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resendWorkspaceInvitation } from '../../backend/tenant/workspace-invitations';

type Call = { sql: string; params: unknown[] };

function recording(respond: (sql: string, params: unknown[]) => { rowCount: number | null; rows: Array<Record<string, unknown>> }) {
  const calls: Call[] = [];
  return {
    calls,
    queryable: {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return respond(sql, params);
      },
    },
  };
}

// A signed-in EXISTING account (has real credentials) whose pointer org is
// their OWN workspace (org 3), invited to a SECOND workspace (org 15). This is
// the multi-workspace happy case the chooser targets.
function existingAccountRow() {
  return {
    id: 42,
    organization_id: 3, // their current/pointer workspace, NOT the invited org 15
    email: 'existing@example.com',
    full_name: 'Existing User',
    role: 'tenant_analyst',
    password_hash: '$2b$12$realcredentialhash',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

test('security: chooser resend for an org the signed-in account does NOT point at returns tenant_mismatch — never mints a token', async () => {
  const { calls, queryable } = recording((sql) => {
    if (/FROM users u\s+WHERE u\.id = \$1/i.test(sql)) {
      return { rowCount: 1, rows: [existingAccountRow()] };
    }
    return { rowCount: 1, rows: [] };
  });

  const result = await resendWorkspaceInvitation(queryable as never, {
    organizationId: '15',
    userId: '42',
    invitedByUserId: null,
  });

  // Pointer (org 3) ≠ requested org (15) → tenant_mismatch, and crucially NO
  // invitation row is inserted (no token minted for a mismatched org).
  assert.equal(result.status, 'tenant_mismatch');
  assert.ok(
    !calls.some((c) => /INSERT INTO workspace_invitations/.test(c.sql)),
    'a mismatched org must never mint an invitation token',
  );
});

test('PHASE-1 LIMITATION (flip in Phase 2): the chooser Accept path cannot complete for a zero-membership invitee', async () => {
  // The zero-membership invitee's users.organization_id pointer is NULL (they
  // were never provisioned into the invited org — that is the whole point of
  // the chooser). resendWorkspaceInvitation → getTenantUserProfileById →
  // tenant_mismatch/not_found, so the chooser action's rawToken stays null and
  // it redirects ?error=invite_link. This asserts the CURRENT (limited)
  // behavior explicitly. When Phase 2 re-scopes the resend gate to the
  // membership row, this expectation must change to status:'ok' — the failing
  // assertion is the signal to do so.
  const { queryable } = recording((sql) => {
    if (/FROM users u\s+WHERE u\.id = \$1/i.test(sql)) {
      return {
        rowCount: 1,
        rows: [{ ...existingAccountRow(), organization_id: null }], // zero-membership pointer
      };
    }
    return { rowCount: 1, rows: [] };
  });

  const result = await resendWorkspaceInvitation(queryable as never, {
    organizationId: '15',
    userId: '42',
    invitedByUserId: null,
  });

  assert.notEqual(
    result.status,
    'ok',
    'Phase 1: resend is pointer-scoped, so the chooser Accept action is a dead end for a zero-membership invitee — ' +
      'when this flips to ok, re-scope the assertion (Phase 2, eng finding 2)',
  );
});

test('security: resend refuses an already-active pointer-matched member (no silent re-invite of a joined account)', async () => {
  // Even when the pointer DOES match the requested org, an already-active
  // account (real password, not the pending sentinel) resends nothing — the
  // resend path is for pending invitees only.
  const { calls, queryable } = recording((sql) => {
    if (/FROM users u\s+WHERE u\.id = \$1/i.test(sql)) {
      return { rowCount: 1, rows: [{ ...existingAccountRow(), organization_id: 15 }] };
    }
    return { rowCount: 1, rows: [] };
  });

  const result = await resendWorkspaceInvitation(queryable as never, {
    organizationId: '15',
    userId: '42',
    invitedByUserId: null,
  });

  assert.equal(result.status, 'already_active');
  assert.ok(!calls.some((c) => /INSERT INTO workspace_invitations/.test(c.sql)));
});
