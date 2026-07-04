/**
 * Workspace switch endpoint SECURITY supplement (plan Phase 3, Decision 2 + CEO
 * hardening 3; Error & Rescue Registry switchWorkspace rows; Failure Modes
 * "switch: role/pointer skew" REQUIRED).
 *
 * The switch domain contract (happy/refusal paths) is covered by
 * tests/tenant/workspace-switch.test.ts. This file adds the two invariants that
 * file does not assert:
 *   1. NO skew window in CALL ORDER — the pointer+role mirror UPDATE happens
 *      strictly between BEGIN and COMMIT, and last_active_at is stamped inside
 *      the same txn, so no request in the switch window can carry the target's
 *      tenantId with the source's role (or vice-versa). A switch must NEVER
 *      grant a role/pointer for a workspace the caller isn't an ACTIVE member of.
 *   2. The refusal paths do NOT leak an ok pointer move — non-member / invited /
 *      corrupt-role all roll back with zero pointer writes.
 * Plus a structural pin that the ROUTE enforces flag-OFF → 404 and maps the
 * domain refusals onto the registry status codes (403 not_a_member /
 * 403 invitation_pending), since the route imports auth()+pool and is not
 * unit-drivable here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { switchActiveWorkspace } from '../../backend/tenant/workspace-switch';
import { repoPath } from '../prd-invariants/_helpers';

const FLAG_ON = { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'production' } as NodeJS.ProcessEnv;

type Call = { sql: string; params: unknown[] };

function fakeClient(targetRows: Record<string, unknown>[]) {
  const calls: Call[] = [];
  const client = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (/FROM organization_memberships m/.test(sql) && /JOIN organizations o/.test(sql)) {
        return { rows: targetRows, rowCount: targetRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

const idx = (calls: Call[], re: RegExp) => calls.findIndex((c) => re.test(c.sql));

// ── Skew-window / transaction ordering (Failure Modes: "role/pointer skew") ──

test('switch: the pointer+role mirror UPDATE lands strictly BETWEEN begin and commit (no skew window)', async () => {
  const { client, calls } = fakeClient([
    { membership_role: 'tenant_analyst', membership_status: 'active', org_id: 9, org_name: 'Acme', org_slug: 'acme' },
  ]);
  const result = await switchActiveWorkspace(client, { userId: 5, targetOrganizationId: 9 }, FLAG_ON);
  assert.equal(result.status, 'ok');

  const beginAt = idx(calls, /^BEGIN$/);
  const pointerAt = idx(calls, /UPDATE users SET organization_id = \$1, role = \$2/);
  const lastActiveAt = idx(calls, /UPDATE organization_memberships[\s\S]*last_active_at = now\(\)/);
  const commitAt = idx(calls, /^COMMIT$/);

  assert.ok(beginAt >= 0, 'a transaction must be opened');
  assert.ok(commitAt >= 0, 'a transaction must be committed');
  assert.ok(pointerAt > beginAt, 'pointer+role move must happen AFTER begin');
  assert.ok(pointerAt < commitAt, 'pointer+role move must happen BEFORE commit');
  assert.ok(lastActiveAt > beginAt && lastActiveAt < commitAt, 'last_active_at stamp must be inside the same txn');
  // The membership SELECT (the ACTIVE-membership validation) must precede the
  // pointer write — the switch is authorized off the locked membership row, not
  // off client input.
  const selectAt = idx(calls, /FROM organization_memberships m/);
  assert.ok(selectAt > beginAt && selectAt < pointerAt, 'membership validation must precede the repoint, inside the txn');
});

test('switch: the ACTIVE-membership SELECT locks the row FOR UPDATE (serializes against concurrent remove/role-change)', async () => {
  const { client, calls } = fakeClient([
    { membership_role: 'tenant_admin', membership_status: 'active', org_id: 9, org_name: 'Acme', org_slug: 'acme' },
  ]);
  await switchActiveWorkspace(client, { userId: 5, targetOrganizationId: 9 }, FLAG_ON);
  const select = calls.find((c) => /FROM organization_memberships m/.test(c.sql));
  assert.ok(select, 'the membership validation SELECT must run');
  assert.match(select!.sql, /FOR UPDATE/i, 'the membership row must be locked so a concurrent remove/role-change serializes');
  assert.match(select!.sql, /WHERE m\.user_id = \$1 AND m\.organization_id = \$2/);
});

// ── Refusal paths leak no pointer move (never grant an unowned workspace) ─────

test('switch: a non-member target rolls back and writes NO pointer/role/last_active (no skew, no grant)', async () => {
  const { client, calls } = fakeClient([]); // no membership row
  const result = await switchActiveWorkspace(client, { userId: 5, targetOrganizationId: 9 }, FLAG_ON);
  assert.equal(result.status, 'not_member');
  assert.equal(idx(calls, /UPDATE users SET organization_id/), -1, 'must not repoint');
  assert.equal(idx(calls, /UPDATE organization_memberships/), -1, 'must not stamp last_active_at');
  assert.ok(idx(calls, /^ROLLBACK$/) >= 0, 'the txn must roll back');
  assert.equal(idx(calls, /^COMMIT$/), -1, 'a refused switch must never commit');
});

test('switch: an invited (non-active) membership target rolls back with NO pointer move (invitation_pending, not a grant)', async () => {
  const { client, calls } = fakeClient([
    { membership_role: 'tenant_admin', membership_status: 'invited', org_id: 9, org_name: 'Acme', org_slug: 'acme' },
  ]);
  const result = await switchActiveWorkspace(client, { userId: 5, targetOrganizationId: 9 }, FLAG_ON);
  assert.equal(result.status, 'invited');
  assert.equal(idx(calls, /UPDATE users SET organization_id/), -1,
    'an invited membership must never grant the target workspace');
  assert.ok(idx(calls, /^ROLLBACK$/) >= 0);
});

test('switch: an org id the user has an ACTIVE membership for is authorized off the DB row, not the request', async () => {
  // The target org id comes from the request, but authorization is the locked
  // membership row's status='active' — an id for an org the user is NOT an
  // active member of can never repoint (covered above); this asserts the happy
  // path reads role from the MEMBERSHIP row, not from any client field.
  const { client, calls } = fakeClient([
    { membership_role: 'tenant_viewer', membership_status: 'active', org_id: 9, org_name: 'Acme', org_slug: 'acme' },
  ]);
  const result = await switchActiveWorkspace(client, { userId: 5, targetOrganizationId: 9 }, FLAG_ON);
  assert.equal(result.status, 'ok');
  assert.equal((result as { role: string }).role, 'tenant_viewer', 'the mirrored role must be the MEMBERSHIP role');
  const pointer = calls.find((c) => /UPDATE users SET organization_id = \$1, role = \$2/.test(c.sql));
  assert.deepEqual(pointer!.params, [9, 'tenant_viewer', 5], 'the role written is the membership role, not a client value');
});

// ── Route-level flag-OFF 404 + status mapping (route is not unit-drivable) ───

test('the switch ROUTE enforces flag-OFF → 404 and maps refusals onto the registry status codes', () => {
  const route = readFileSync(repoPath('app/api/tenant/workspace/switch/route.ts'), 'utf8');

  // Flag OFF → a real 404 (invisible endpoint, no DB reads), checked before auth.
  assert.match(route, /if\s*\(!isMultiWorkspaceEnabled\(\)\)\s*\{[\s\S]*?status:\s*404/,
    'flag OFF must return a 404 before any DB/session work');

  // Domain refusals → HTTP per the Error & Rescue Registry:
  //   not_member → 403 not_a_member ; invited → 403 invitation_pending.
  assert.match(route, /case 'not_member':[\s\S]*?'not_a_member'[\s\S]*?403/,
    "a non-member target must map to 403 not_a_member");
  assert.match(route, /case 'invited':[\s\S]*?'invitation_pending'[\s\S]*?403/,
    "an invited membership must map to 403 invitation_pending");

  // The route gates on a signed-in session (it deliberately does NOT gate on
  // getTenantContext — the switch would 409 itself), and validates membership
  // server-side inside switchActiveWorkspace.
  assert.match(route, /session\?\.user\?\.id/, 'the route must require a signed-in session');
  assert.match(route, /switchActiveWorkspace\(/, 'the route must validate membership via switchActiveWorkspace');
});
