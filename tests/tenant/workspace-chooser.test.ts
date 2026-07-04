/**
 * Multi-workspace Phase 1 — zero-membership blast radius (plan eng finding 9,
 * Decision 7, design spec "Zero-membership chooser is invite-aware").
 *
 * Behavioral coverage for listPendingWorkspaceInvites plus structural pins for
 * the journey wiring: onboarding gate → chooser (never the org-minting
 * onboarding resume), post-login → chooser, chooser page outside the gated
 * dashboard layout, and the accept action's own-membership guard.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  listPendingWorkspaceInvites,
  WORKSPACE_CHOOSER_PATH,
} from '../../backend/tenant/workspace-chooser';
import { resolveProjectRoot } from '../helpers/project-root';

const REPO_ROOT = path.join(resolveProjectRoot(import.meta.url), '..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// listPendingWorkspaceInvites
// ---------------------------------------------------------------------------

test('listPendingWorkspaceInvites queries invited memberships newest-first and maps rows frontend-safe', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryable = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return {
        rowCount: 2,
        rows: [
          {
            organization_id: 15,
            role: 'tenant_analyst',
            invited_at: new Date('2026-07-01T12:00:00.000Z'),
            workspace_name: 'Sugar & Leather',
          },
          { organization_id: 9, role: null, invited_at: null, workspace_name: '' },
        ],
      };
    },
  };

  const invites = await listPendingWorkspaceInvites(queryable as never, '42');

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM organization_memberships m/);
  assert.match(calls[0].sql, /JOIN organizations o ON o\.id = m\.organization_id/);
  assert.match(calls[0].sql, /m\.status = 'invited'/);
  assert.match(calls[0].sql, /ORDER BY m\.invited_at DESC NULLS LAST, m\.created_at DESC/);
  assert.deepEqual(calls[0].params, [42]);
  assert.deepEqual(invites, [
    {
      organizationId: '15',
      workspaceName: 'Sugar & Leather',
      role: 'tenant_analyst',
      invitedAt: '2026-07-01T12:00:00.000Z',
    },
    { organizationId: '9', workspaceName: null, role: null, invitedAt: null },
  ]);
});

test('listPendingWorkspaceInvites returns [] when the user has no invited memberships', async () => {
  const queryable = {
    async query() {
      return { rowCount: 0, rows: [] };
    },
  };
  assert.deepEqual(await listPendingWorkspaceInvites(queryable as never, 42), []);
});

// ---------------------------------------------------------------------------
// Journey wiring pins
// ---------------------------------------------------------------------------

test('the chooser page lives OUTSIDE the gated dashboard layout', () => {
  assert.equal(WORKSPACE_CHOOSER_PATH, '/workspace/choose');
  assert.ok(
    existsSync(path.join(REPO_ROOT, 'app/workspace/choose/page.tsx')),
    'app/workspace/choose/page.tsx must exist',
  );
  assert.ok(
    !existsSync(path.join(REPO_ROOT, 'app/dashboard/workspace')),
    'the chooser must not live under the gated dashboard tree (eng finding 9)',
  );
  assert.ok(
    !existsSync(path.join(REPO_ROOT, 'app/workspace/layout.tsx')) ||
      !/enforceOnboardingGate/.test(read('app/workspace/layout.tsx')),
    'no onboarding gate may wrap the chooser (redirect loop hazard)',
  );
});

test('onboarding gate: zero-membership (flag ON) redirects to the chooser, NEVER the org-minting resume page', () => {
  const src = read('lib/onboarding-gate-server.ts');
  const gateBranch = src.indexOf("error.reason === 'tenant_membership_missing'");
  const legacyRedirect = src.indexOf('redirect(GATE_REDIRECT_DESTINATION)');
  assert.ok(gateBranch >= 0, 'gate must have an explicit zero-membership branch');
  assert.ok(src.includes('isMultiWorkspaceEnabled()'), 'the branch is flag-gated');
  assert.ok(src.includes('redirect(WORKSPACE_CHOOSER_PATH)'), 'the branch redirects to the chooser');
  assert.ok(
    gateBranch < legacyRedirect,
    'the zero-membership branch must be checked BEFORE the generic onboarding redirect',
  );
});

test('post-login journey: zero-membership (flag ON) lands on the chooser instead of onboarding', () => {
  const src = read('app/auth/post-login/page.tsx');
  assert.ok(src.includes('isMultiWorkspaceEnabled()'), 'flag-gated');
  assert.ok(
    src.includes("error.reason === 'tenant_membership_missing'"),
    'keys on the typed zero-membership state',
  );
  assert.ok(src.includes('WORKSPACE_CHOOSER_PATH'), 'routes to the chooser');
});

test('chooser page is invite-aware with the spec fallback copy', () => {
  const src = read('app/workspace/choose/page.tsx');
  assert.ok(src.includes('listPendingWorkspaceInvites'), 'checks pending invites first');
  assert.ok(src.includes('acceptPendingInviteAction'), 'pending invite → accept action is the primary');
  assert.ok(src.includes('Create a workspace'), 'invite-less fallback primary');
  assert.ok(src.includes('Waiting for an invite?'), 'invite-less secondary explainer');
  assert.ok(src.includes('GATE_REDIRECT_DESTINATION'), 'create links into today\'s onboarding entry');
  assert.ok(/Phase 4[\s\S]{0,200}entitlement/.test(src), 'Phase-4 entitlement gate comment is present');
});

test('accept action re-issues ONLY the caller\'s own invited membership and never leaks the token on failure', () => {
  const src = read('app/workspace/choose/actions.ts');
  assert.ok(src.includes("status = 'invited'"), 'guards on an invited membership row');
  assert.ok(src.includes('session.user.id'), 'scoped to the signed-in account');
  assert.ok(src.includes('resendWorkspaceInvitation'), 'reuses the existing resend machinery (supersede semantics)');
  assert.ok(src.includes('error=invite_link'), 'failure surfaces a frontend-safe code');
  assert.ok(!/console\.log\([^)]*token/i.test(src), 'never logs the token');
});
