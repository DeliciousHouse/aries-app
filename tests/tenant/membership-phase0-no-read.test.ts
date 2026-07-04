import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from '../helpers/project-root';

// Phase-0 no-behavior-change golden guard
// (docs/plans/2026-07-03-multi-workspace-membership.md — "Phase 0 … no behavior
// change" / Test strategy "Golden byte-identical OFF"). The full resolver golden
// suite lands in Phase 1 when the membership READ path is built behind the flag.
// For Phase 0 the load-bearing invariant is the negative one: the dark schema +
// dual-write are ADDITIVE and NOTHING in the runtime READS organization_memberships
// yet — tenant resolution (getTenantContext / the claims helpers) still derives
// (org, role) from the single users/organizations pointer, byte-identical to today.
//
// This is a cheap structural assertion over the two resolver modules rather than a
// fixture golden: if a later edit wires a membership join into resolution WITHOUT
// the phase flag, this fails and forces that change into Phase 1 where it belongs.

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const REPO_ROOT = path.join(PROJECT_ROOT, '..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

test('tenant resolution does NOT read organization_memberships in Phase 0', () => {
  // lib/tenant-context.ts — getTenantContext → loadTenantContextForUser.
  const tenantContext = read('lib/tenant-context.ts');
  assert.ok(
    !/organization_memberships/i.test(tenantContext),
    'lib/tenant-context.ts must not join/read organization_memberships in Phase 0 (READ path is Phase 1)',
  );
  // The resolution query still derives role + org from the users/organizations
  // pointer, not a membership row.
  assert.match(
    tenantContext,
    /FROM users u\s+LEFT JOIN organizations o ON o\.id = u\.organization_id/,
    'resolution still joins users → organizations only',
  );
  assert.match(tenantContext, /u\.role/, 'role is still read from users.role, not a membership row');
});

test('the claims helpers still resolve from users/organizations, not memberships', () => {
  const source = read('lib/auth-tenant-membership.ts');

  // Isolate the two claims-resolution helpers and prove neither joins the
  // membership table. (upsertOrganizationMembership / assignUserToOrganization DO
  // touch organization_memberships — those are WRITE paths, so we scope the
  // assertion to the read helpers rather than the whole file.)
  for (const fnName of ['findTenantClaimsByUserId', 'findTenantClaimsByEmail']) {
    const start = source.indexOf(`export async function ${fnName}`);
    assert.ok(start >= 0, `expected ${fnName} to exist`);
    // Grab a generous window covering the function body (both are ~30 lines).
    const body = source.slice(start, start + 1400);
    assert.ok(
      !/organization_memberships/i.test(body),
      `${fnName} must not read organization_memberships in Phase 0`,
    );
    assert.match(
      body,
      /FROM users u\s+LEFT JOIN organizations o/,
      `${fnName} still resolves from users → organizations`,
    );
    assert.match(body, /u\.role/, `${fnName} still reads role from users.role`);
  }
});

test('no runtime module outside the membership WRITE helper reads organization_memberships in Phase 0', () => {
  // A repo-wide guard: the only place the new table may appear is the dual-write
  // helper (lib/auth-tenant-membership.ts) and the DDL/migration/backfill. If a
  // reader shows up in lib/backend/app source, Phase 0's "nothing reads it yet"
  // invariant is broken and this catches it.
  //
  // Phase 0.5 exception: backend/tenant/workspace-invitations.ts now carries the
  // absorb-orphan flow, whose orphan predicate COUNTS membership rows and whose
  // accept transaction MOVES the membership row alongside the pointer repoint
  // (plan eng finding 3b). That is a bounded absorb-flow read, not tenant
  // resolution — the resolution modules below stay membership-free until the
  // Phase 1 flag-gated READ path lands.
  const grepTargets = [
    'lib/tenant-context.ts',
    'lib/auth-user-journey.ts',
    'backend/tenant/user-profiles.ts',
    'app/actions/auth.ts',
  ];
  for (const rel of grepTargets) {
    const src = read(rel);
    // The three write paths import/call upsertOrganizationMembership by name;
    // that is a WRITE, not a read of the table. What must be absent everywhere is
    // a SELECT/FROM/JOIN against organization_memberships.
    assert.ok(
      !/(from|join)\s+organization_memberships/i.test(src),
      `${rel} must not SELECT/JOIN organization_memberships in Phase 0`,
    );
  }
});
