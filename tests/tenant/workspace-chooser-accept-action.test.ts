/**
 * Multi-workspace chooser "Accept invite" action: security + the Phase-2 flip
 * (docs/plans/2026-07-03-multi-workspace-membership.md, design spec
 * "Zero-membership chooser is invite-aware"; eng finding 2 — the resend gate
 * moved to membership.status in Phase 2).
 *
 * The chooser cannot link the emailed (hashed) token, so its Accept action
 * re-mints the caller's own invitation via resendWorkspaceInvitation, then
 * hands off to /invite/accept. This file pins:
 *   (A) the security floor — resend is scoped to the SIGNED-IN account's own
 *       invited membership; an org the account has no membership row in can
 *       never mint a token;
 *   (B) the Phase-2 flip — flag ON, resend keys on the (user, org) membership
 *       row's status='invited', so the exact zero-membership-pointer case the
 *       chooser exists for now completes (Phase 1 pinned this as a dead end:
 *       the pointer-scoped lookup returned tenant_mismatch);
 *   (C) the flag-OFF pin — the legacy pointer-scoped gate is byte-identical
 *       (the chooser action itself is unreachable flag-OFF, but the shared
 *       resend path must not drift).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resendWorkspaceInvitation } from '../../backend/tenant/workspace-invitations';

const FLAG_ON = { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'test' } as NodeJS.ProcessEnv;
const FLAG_OFF = { ARIES_MULTI_WORKSPACE_ENABLED: '0', NODE_ENV: 'test' } as NodeJS.ProcessEnv;

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

// ── Flag ON (Phase 2): membership-scoped resend gate ────────────────────────

test('flag ON security: resend for an org the account has NO membership in returns tenant_mismatch — never mints a token', async () => {
  const { calls, queryable } = recording((sql) => {
    if (/FROM organization_memberships m/i.test(sql)) {
      return { rowCount: 0, rows: [] }; // no (user 42, org 15) membership row
    }
    if (/SELECT 1 FROM users WHERE id = \$1/i.test(sql)) {
      return { rowCount: 1, rows: [{ '?column?': 1 }] }; // the user exists
    }
    return { rowCount: 0, rows: [] };
  });

  const result = await resendWorkspaceInvitation(
    queryable as never,
    { organizationId: '15', userId: '42', invitedByUserId: null },
    FLAG_ON,
  );

  assert.equal(result.status, 'tenant_mismatch');
  assert.ok(
    !calls.some((c) => /INSERT INTO workspace_invitations/.test(c.sql)),
    'an org without a membership row must never mint an invitation token',
  );
});

test('PHASE-2 FLIP (eng finding 2): the chooser Accept path now completes for a zero-membership-pointer invitee', async () => {
  // The zero-membership invitee's users.organization_id pointer is NULL — but
  // the (user 42, org 15) membership row is status='invited' (the dual-write
  // every invite creates). Flag ON, resend keys on THAT row, so the chooser
  // action mints a real token and hands off to /invite/accept. This is the
  // assertion the Phase-1 pin ("resend is pointer-scoped, so the chooser
  // Accept action is a dead end") demanded be flipped in Phase 2.
  const { calls, queryable } = recording((sql) => {
    if (/FROM organization_memberships m/i.test(sql)) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 42,
            email: 'existing@example.com',
            password_hash: '$2b$12$realcredentialhash',
            role: 'tenant_analyst',
            status: 'invited',
          },
        ],
      };
    }
    return { rowCount: 0, rows: [] };
  });

  const result = await resendWorkspaceInvitation(
    queryable as never,
    { organizationId: '15', userId: '42', invitedByUserId: null },
    FLAG_ON,
  );

  assert.equal(result.status, 'ok', 'Phase 2: the membership-scoped resend gate makes the chooser Accept action real');
  if (result.status !== 'ok') return;
  assert.equal(result.email, 'existing@example.com');
  assert.equal(result.role, 'tenant_analyst');
  // The account has real credentials → the emailed copy is the
  // existing-account variant, never "set your password".
  assert.equal(result.emailVariant, 'existing_account');
  assert.ok(calls.some((c) => /INSERT INTO workspace_invitations/.test(c.sql)));

  // Supersede is scoped to (user, org): re-minting org 15's token must not
  // kill a pending invitation from another org.
  const supersede = calls.find((c) => /UPDATE workspace_invitations\s+SET expires_at = now\(\)/i.test(c.sql));
  assert.ok(supersede, 'expected the prior live token to be superseded');
  assert.match(supersede!.sql, /organization_id = \$2/);
  assert.deepEqual(supersede!.params, [42, 15]);
});

test('flag ON security: resend refuses an already-ACTIVE membership (no silent re-invite of a joined account)', async () => {
  const { calls, queryable } = recording((sql) => {
    if (/FROM organization_memberships m/i.test(sql)) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 42,
            email: 'existing@example.com',
            password_hash: '$2b$12$realcredentialhash',
            role: 'tenant_analyst',
            status: 'active',
          },
        ],
      };
    }
    return { rowCount: 0, rows: [] };
  });

  const result = await resendWorkspaceInvitation(
    queryable as never,
    { organizationId: '15', userId: '42', invitedByUserId: null },
    FLAG_ON,
  );

  assert.equal(result.status, 'already_active');
  assert.ok(!calls.some((c) => /INSERT INTO workspace_invitations/.test(c.sql)));
});

// ── Flag OFF pins: the legacy pointer-scoped gate is unchanged ──────────────

test('flag OFF pin: resend for an org the signed-in account does NOT point at returns tenant_mismatch — never mints a token', async () => {
  const { calls, queryable } = recording((sql) => {
    if (/FROM users u\s+WHERE u\.id = \$1/i.test(sql)) {
      return { rowCount: 1, rows: [existingAccountRow()] };
    }
    return { rowCount: 1, rows: [] };
  });

  const result = await resendWorkspaceInvitation(
    queryable as never,
    { organizationId: '15', userId: '42', invitedByUserId: null },
    FLAG_OFF,
  );

  // Pointer (org 3) ≠ requested org (15) → tenant_mismatch, and crucially NO
  // invitation row is inserted (no token minted for a mismatched org).
  assert.equal(result.status, 'tenant_mismatch');
  assert.ok(
    !calls.some((c) => /INSERT INTO workspace_invitations/.test(c.sql)),
    'a mismatched org must never mint an invitation token',
  );
  assert.ok(
    !calls.some((c) => /FROM organization_memberships/i.test(c.sql)),
    'flag OFF must not read the membership table',
  );
});

test('flag OFF pin: resend refuses an already-active pointer-matched member', async () => {
  const { calls, queryable } = recording((sql) => {
    if (/FROM users u\s+WHERE u\.id = \$1/i.test(sql)) {
      return { rowCount: 1, rows: [{ ...existingAccountRow(), organization_id: 15 }] };
    }
    return { rowCount: 1, rows: [] };
  });

  const result = await resendWorkspaceInvitation(
    queryable as never,
    { organizationId: '15', userId: '42', invitedByUserId: null },
    FLAG_OFF,
  );

  assert.equal(result.status, 'already_active');
  assert.ok(!calls.some((c) => /INSERT INTO workspace_invitations/.test(c.sql)));
});
