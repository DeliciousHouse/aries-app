/**
 * Multi-workspace Phase 1 — flag-ON membership-aware resolution
 * (docs/plans/2026-07-03-multi-workspace-membership.md, Phase 1 / Decisions
 * 3 + 6 + 7, CEO hardening 4, eng findings 1b + 8 + 9 + 13).
 *
 * The flag-OFF byte-identical pin lives in
 * tests/auth/tenant-resolution-flag-off-golden.test.ts. This file covers the
 * ARIES_MULTI_WORKSPACE_ENABLED=1 path:
 *   - ONE indexed query (users ⋈ organization_memberships ⋈ organizations),
 *     role from the MEMBERSHIP row, workspace_count riding the same statement;
 *   - pointer → org with no ACTIVE membership resolves like NULL;
 *   - resolver self-heal for a pointer with NO membership row (and only then);
 *   - typed zero-membership state (tenant_membership_missing, not
 *     claims-incomplete);
 *   - ensureTenantAccessForUser: no minting at zero memberships, deterministic
 *     repoint at N≥1.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Pin the flag ON for this whole file (tsx --test = one process per file).
process.env.ARIES_MULTI_WORKSPACE_ENABLED = '1';

import { isMultiWorkspaceEnabled } from '../../backend/tenant/multi-workspace-env';
import {
  ensureTenantAccessForUser,
  findTenantClaimsByEmail,
  resolveTenantClaimsRow,
} from '../../lib/auth-tenant-membership';
import {
  loadTenantContextForUser,
  resolveTenantContextForSession,
  TenantContextError,
} from '../../lib/tenant-context';
import { resolveProjectRoot } from '../helpers/project-root';

type Call = { sql: string; params: unknown[] };

function recordingQueryable(
  respond: (sql: string, params: unknown[], callIndex: number) => {
    rowCount: number | null;
    rows: Array<Record<string, unknown>>;
  },
) {
  const calls: Call[] = [];
  return {
    calls,
    queryable: {
      async query(sql: string, params: unknown[] = []) {
        const result = respond(sql, params, calls.length);
        calls.push({ sql, params });
        return result;
      },
    },
  };
}

/** Raw row shape returned by the flag-ON membership claims query. */
function rawRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    user_id: '42',
    pointer_organization_id: '7',
    pointer_role: 'tenant_admin',
    org_id: '7',
    org_slug: 'acme-co',
    membership_role: 'tenant_analyst',
    membership_status: 'active',
    workspace_count: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Flag module
// ---------------------------------------------------------------------------

test('isMultiWorkspaceEnabled: truthy set is 1|true|yes|on, default OFF', () => {
  for (const v of ['1', 'true', 'yes', 'on', ' TRUE ', 'On']) {
    assert.equal(isMultiWorkspaceEnabled({ ARIES_MULTI_WORKSPACE_ENABLED: v }), true, `expected "${v}" to enable`);
  }
  for (const v of ['0', 'false', 'no', 'off', '', 'enabled', undefined]) {
    assert.equal(isMultiWorkspaceEnabled({ ARIES_MULTI_WORKSPACE_ENABLED: v }), false, `expected "${v}" to disable`);
  }
  assert.equal(isMultiWorkspaceEnabled({}), false);
});

// ---------------------------------------------------------------------------
// resolveTenantClaimsRow — flag ON
// ---------------------------------------------------------------------------

test('flag ON: ONE membership-validated query; role comes from the MEMBERSHIP row; workspace_count rides it', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [rawRow()] }));

  const row = await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });

  assert.equal(calls.length, 1, 'hot path must be exactly one query (CEO hardening 4 / eng 13)');
  assert.match(calls[0].sql, /LEFT JOIN organization_memberships m/);
  assert.match(calls[0].sql, /m\.organization_id = u\.organization_id/);
  assert.match(calls[0].sql, /am\.status = 'active'/, 'workspace_count counts ACTIVE memberships in the same statement');
  assert.deepEqual(calls[0].params, [42]);
  assert.deepEqual(row, {
    user_id: '42',
    organization_id: '7',
    tenant_id: '7',
    tenant_slug: 'acme-co',
    role: 'tenant_analyst', // membership role, NOT users.role ('tenant_admin')
    workspace_count: 2,
  });
});

test('flag ON: the email lookup rides the same single membership query', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [rawRow()] }));

  const row = await findTenantClaimsByEmail(queryable as never, 'User@Example.com');

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /LEFT JOIN organization_memberships m/);
  assert.match(calls[0].sql, /WHERE LOWER\(u\.email\) = LOWER\(\$1\)/);
  assert.deepEqual(calls[0].params, ['User@Example.com']);
  assert.equal(row?.role, 'tenant_analyst');
});

test("flag ON: pointer → org with an 'invited' (non-active) membership resolves like NULL and NEVER self-heals", async () => {
  const { calls, queryable } = recordingQueryable(() => ({
    rowCount: 1,
    rows: [rawRow({ membership_role: 'tenant_viewer', membership_status: 'invited', workspace_count: 0 })],
  }));

  const row = await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });

  assert.equal(calls.length, 1, 'an invited membership must not trigger the self-heal INSERT');
  assert.deepEqual(row, {
    user_id: '42',
    organization_id: null,
    tenant_id: null,
    tenant_slug: null,
    role: null,
    workspace_count: 0,
  });
});

test('flag ON: pointer → existing org with NO membership row self-heals ONE active membership then re-resolves', async () => {
  const { calls, queryable } = recordingQueryable((sql, _params, index) => {
    if (/INSERT INTO organization_memberships/.test(sql)) {
      return { rowCount: 1, rows: [] };
    }
    // First select: no membership row at all. Second select (post-heal): active.
    return index === 0
      ? { rowCount: 1, rows: [rawRow({ membership_role: null, membership_status: null, workspace_count: 0 })] }
      : { rowCount: 1, rows: [rawRow({ membership_role: 'tenant_admin', membership_status: 'active', workspace_count: 1 })] };
  });

  const row = await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });

  assert.equal(calls.length, 3, 'select → self-heal insert → re-select');
  assert.match(calls[1].sql, /INSERT INTO organization_memberships/);
  assert.match(calls[1].sql, /ON CONFLICT \(user_id, organization_id\) DO NOTHING/, 'self-heal must never overwrite a concurrent row');
  assert.match(calls[1].sql, /'active'/);
  assert.deepEqual(calls[1].params, [42, 7, 'tenant_admin'], 'membership derived from the pointer + users.role');
  assert.deepEqual(row, {
    user_id: '42',
    organization_id: '7',
    tenant_id: '7',
    tenant_slug: 'acme-co',
    role: 'tenant_admin',
    workspace_count: 1,
  });
});

test('flag ON: self-heal is skipped for a dangling pointer (org deleted) — resolves like NULL', async () => {
  const { calls, queryable } = recordingQueryable(() => ({
    rowCount: 1,
    rows: [rawRow({ org_id: null, org_slug: null, membership_role: null, membership_status: null, workspace_count: 0 })],
  }));

  const row = await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });

  assert.equal(calls.length, 1);
  assert.equal(row?.organization_id, null);
  assert.equal(row?.workspace_count, 0);
});

test('flag ON: self-heal is skipped when users.role is not a valid tenant role', async () => {
  const { calls, queryable } = recordingQueryable(() => ({
    rowCount: 1,
    rows: [rawRow({ pointer_role: 'platform_owner', membership_role: null, membership_status: null, workspace_count: 0 })],
  }));

  const row = await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });

  assert.equal(calls.length, 1, 'no INSERT without a valid role to stamp (memberships have no role default)');
  assert.equal(row?.role, null);
});

test('flag ON: NULL pointer + zero memberships resolves to the typed zero-membership shape', async () => {
  const { queryable } = recordingQueryable(() => ({
    rowCount: 1,
    rows: [
      rawRow({
        pointer_organization_id: null,
        org_id: null,
        org_slug: null,
        membership_role: null,
        membership_status: null,
        workspace_count: 0,
      }),
    ],
  }));

  const row = await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });

  assert.deepEqual(row, {
    user_id: '42',
    organization_id: null,
    tenant_id: null,
    tenant_slug: null,
    role: null,
    workspace_count: 0,
  });
});

// ---------------------------------------------------------------------------
// loadTenantContextForUser / resolveTenantContextForSession — flag ON
// ---------------------------------------------------------------------------

test('flag ON: loadTenantContextForUser maps an active membership row (membership role wins)', async () => {
  const { queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [rawRow()] }));

  const context = await loadTenantContextForUser(queryable as never, '42');

  assert.deepEqual(context, {
    userId: '42',
    tenantId: '7',
    tenantSlug: 'acme-co',
    role: 'tenant_analyst',
  });
});

test('flag ON: zero-membership surfaces the TYPED tenant_membership_missing state (not claims-incomplete)', async () => {
  const { queryable } = recordingQueryable(() => ({
    rowCount: 1,
    rows: [
      rawRow({
        pointer_organization_id: null,
        org_id: null,
        org_slug: null,
        membership_role: null,
        membership_status: null,
        workspace_count: 0,
      }),
    ],
  }));

  await assert.rejects(
    () => loadTenantContextForUser(queryable as never, '42'),
    (error: unknown) => {
      assert.ok(error instanceof TenantContextError);
      assert.equal(error.reason, 'tenant_membership_missing');
      return true;
    },
  );
});

test('flag ON: zero-membership NEVER falls back to stale session claims (ghost-claims guard)', async () => {
  const { queryable } = recordingQueryable(() => ({
    rowCount: 1,
    rows: [
      rawRow({
        pointer_organization_id: null,
        org_id: null,
        org_slug: null,
        membership_role: null,
        membership_status: null,
        workspace_count: 0,
      }),
    ],
  }));

  await assert.rejects(
    () =>
      resolveTenantContextForSession(queryable as never, {
        user: { id: '42', tenantId: '7', tenantSlug: 'stale-workspace', role: 'tenant_admin' },
        expires: '2099-01-01T00:00:00.000Z',
      }),
    TenantContextError,
  );
});

test('flag ON: API routes surface 403 tenant_membership_missing for the zero-membership state (eng finding 9)', async () => {
  const { loadTenantContextOrResponse } = await import('../../lib/tenant-context-http');

  const outcome = await loadTenantContextOrResponse(async () => {
    throw new TenantContextError(
      'tenant_membership_missing',
      'No active workspace membership found for authenticated user.',
    );
  });

  assert.ok('response' in outcome);
  assert.equal(outcome.response.status, 403);
  const body = (await outcome.response.json()) as { status: string; reason: string };
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'tenant_membership_missing');
});

// ---------------------------------------------------------------------------
// ensureTenantAccessForUser — flag ON (Decision 7)
// ---------------------------------------------------------------------------

const FLAG_ON_ENV = { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'production' } as NodeJS.ProcessEnv;

test('flag ON: a valid pointer+membership is a single-resolution no-op (no org insert, no writes)', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [rawRow()] }));

  await ensureTenantAccessForUser(
    queryable as never,
    { userId: 42, organizationId: 7, role: 'tenant_admin', name: 'Jane', email: 'jane@example.com' },
    FLAG_ON_ENV,
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /LEFT JOIN organization_memberships m/);
});

test('flag ON: ZERO memberships mints NOTHING — no org insert, no pointer write (Decision 7)', async () => {
  const { calls, queryable } = recordingQueryable(() => ({
    rowCount: 1,
    rows: [
      rawRow({
        pointer_organization_id: null,
        org_id: null,
        org_slug: null,
        membership_role: null,
        membership_status: null,
        workspace_count: 0,
      }),
    ],
  }));

  await ensureTenantAccessForUser(
    queryable as never,
    { userId: 42, organizationId: null, role: null, name: 'Jane', email: 'jane@example.com' },
    FLAG_ON_ENV,
  );

  assert.equal(calls.length, 1, 'resolution only');
  for (const call of calls) {
    assert.ok(!/INSERT INTO organizations/i.test(call.sql), 'must not mint a personal org');
    assert.ok(!/UPDATE users/i.test(call.sql), 'must not write the pointer');
  }
});

test('flag ON: invalid pointer + N≥1 active memberships repoints to the deterministic default atomically', async () => {
  const { calls, queryable } = recordingQueryable((sql) => {
    if (/LEFT JOIN organization_memberships m/.test(sql)) {
      // Pointer → org 7 whose membership is only 'invited'; one ACTIVE membership elsewhere.
      return {
        rowCount: 1,
        rows: [rawRow({ membership_role: 'tenant_viewer', membership_status: 'invited', workspace_count: 1 })],
      };
    }
    if (/FROM organization_memberships\s+WHERE user_id = \$1 AND status = 'active'/.test(sql)) {
      return { rowCount: 1, rows: [{ organization_id: 9, role: 'tenant_analyst' }] };
    }
    return { rowCount: 1, rows: [] };
  });

  await ensureTenantAccessForUser(
    queryable as never,
    { userId: 42, organizationId: 7, role: 'tenant_admin', name: 'Jane', email: 'jane@example.com' },
    FLAG_ON_ENV,
  );

  assert.equal(calls.length, 4, 'resolve → pick default → atomic repoint → last_active_at stamp');
  assert.match(
    calls[1].sql,
    /ORDER BY last_active_at DESC NULLS LAST, created_at ASC, organization_id ASC/,
    'deterministic default: most-recently-used, else oldest',
  );
  assert.deepEqual(calls[1].params, [42]);
  // Pointer + legacy role mirror move in ONE statement (CEO hardening 3).
  assert.equal(calls[2].sql, 'UPDATE users SET organization_id = $1, role = $2 WHERE id = $3');
  assert.deepEqual(calls[2].params, [9, 'tenant_analyst', 42]);
  assert.match(calls[3].sql, /SET last_active_at = now\(\)/);
  assert.deepEqual(calls[3].params, [42, 9]);
});

// ---------------------------------------------------------------------------
// auth.ts structural pins (the jwt callback is not importable in isolation —
// pin the load-bearing lines instead so a refactor can't silently drop them)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(resolveProjectRoot(import.meta.url), '..');

test('auth.ts jwt hydrate CLEARS tenant claims when membership resolution returns none (eng finding 8)', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'auth.ts'), 'utf8');
  const hydrateStart = src.indexOf('const hydrateTenantClaimsByUserId');
  assert.ok(hydrateStart >= 0);
  const hydrate = src.slice(hydrateStart, hydrateStart + 2200);
  for (const cleared of ['delete token.tenantId', 'delete token.tenantSlug', 'delete token.tenantRole', 'delete token.timezone']) {
    assert.ok(hydrate.includes(cleared), `jwt hydrate must clear stale claims (missing: ${cleared})`);
  }
  assert.ok(hydrate.includes('isMultiWorkspaceEnabled()'), 'the clear is flag-gated (flag OFF stays set-only)');
  assert.ok(hydrate.includes('workspaceCount'), 'workspaceCount rides the same hydrate row (eng finding 13)');
});

test('auth.ts session callback surfaces workspaceCount only when the token carries it', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'auth.ts'), 'utf8');
  assert.ok(
    /typeof token\.workspaceCount === "number"/.test(src),
    'session callback exposes workspaceCount from the token (never invents one)',
  );
});

test('auth.ts signIn treats zero-membership as a typed allowed state, flag-gated', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'auth.ts'), 'utf8');
  assert.ok(
    /isMultiWorkspaceEnabled\(\) && tenantClaims && !tenantClaims\.organization_id/.test(src),
    'signIn allows the zero-membership state through to the chooser instead of TenantClaimsIncomplete',
  );
});
