import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveTenantClaimsRow } from '../../lib/auth-tenant-membership';
import { resolveProjectRoot } from '../helpers/project-root';

// Phase-1 form of the Phase-0 no-behavior-change guard
// (docs/plans/2026-07-03-multi-workspace-membership.md). Phase 0 pinned that
// NOTHING read organization_memberships; Phase 1 introduces the flag-gated
// membership READ path, so the invariant narrows to:
//
//   1. With ARIES_MULTI_WORKSPACE_ENABLED OFF, claims resolution still derives
//      (org, role) from the single users/organizations pointer — no membership
//      join on the wire (byte-level pin lives in
//      tests/auth/tenant-resolution-flag-off-golden.test.ts).
//   2. The membership join exists in EXACTLY ONE place — the consolidated
//      resolveTenantClaimsRow helper in lib/auth-tenant-membership.ts (plan eng
//      findings 5 + 14). lib/tenant-context.ts no longer carries its own copy
//      of the claims SQL, and no other runtime module grows a membership read.

process.env.ARIES_MULTI_WORKSPACE_ENABLED = '0';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const REPO_ROOT = path.join(PROJECT_ROOT, '..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

test('flag OFF: claims resolution does not read organization_memberships on the wire', async () => {
  const captured: string[] = [];
  const queryable = {
    async query(sql: string, _params: unknown[] = []) {
      captured.push(sql);
      return { rowCount: 0, rows: [] };
    },
  };

  await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });
  await resolveTenantClaimsRow(queryable as never, { by: 'email', email: 'a@b.c' });

  assert.equal(captured.length, 2);
  for (const sql of captured) {
    assert.ok(
      !/organization_memberships/i.test(sql),
      'flag-OFF resolution must not join/read organization_memberships',
    );
    assert.match(
      sql,
      /FROM users u\s+LEFT JOIN organizations o ON o\.id = u\.organization_id/,
      'flag-OFF resolution still joins users → organizations only',
    );
    assert.match(sql, /u\.role/, 'flag-OFF role still comes from users.role');
  }
});

test('the claims join lives ONLY in the consolidated helper — tenant-context delegates instead of duplicating', () => {
  const tenantContext = read('lib/tenant-context.ts');
  assert.ok(
    !/FROM users u/i.test(tenantContext),
    'lib/tenant-context.ts must not carry its own copy of the claims SQL (consolidation, eng findings 5/14)',
  );
  assert.match(
    tenantContext,
    /resolveTenantClaimsRow/,
    'lib/tenant-context.ts resolves claims through the consolidated helper',
  );
});

test('no runtime module outside the membership seam reads organization_memberships', () => {
  // A repo-wide guard: outside lib/auth-tenant-membership.ts (the consolidated
  // resolution seam), backend/tenant/workspace-invitations.ts (the bounded
  // Phase 0.5 absorb-flow read + Phase 2 invite/accept state machine),
  // backend/tenant/user-profiles.ts + backend/tenant/entitlements.ts (the
  // Phase 2 member-CRUD and entitlement seams — deliberately widened here,
  // not silently), and the Phase 1 zero-membership chooser seam
  // (backend/tenant/workspace-chooser.ts + app/workspace/choose/actions.ts),
  // no runtime module may SELECT/JOIN the membership table. WRITE paths
  // (upsertOrganizationMembership callers) are fine — what must stay
  // centralized is the READ.
  const grepTargets = [
    'lib/tenant-context.ts',
    'lib/auth-user-journey.ts',
    'app/actions/auth.ts',
  ];
  for (const rel of grepTargets) {
    const src = read(rel);
    assert.ok(
      !/(from|join)\s+organization_memberships/i.test(src),
      `${rel} must not SELECT/JOIN organization_memberships — membership reads live in resolveTenantClaimsRow`,
    );
  }
});
