/**
 * Multi-workspace Phase 1 — flag-OFF GOLDEN suite (commit 1, written BEFORE the
 * resolver refactor per the plan's non-negotiable ordering rule).
 *
 * docs/plans/2026-07-03-multi-workspace-membership.md — Test strategy:
 * "Golden byte-identical OFF: claims/context resolution ... with flag OFF must
 * match today exactly (fixture-level golden tests, same pattern as the
 * taste-brief golden)."
 *
 * These tests pin the EXACT bytes today's resolution path sends to Postgres —
 * SQL text, parameter arrays, call ordering — plus the exact result/error
 * mapping, for:
 *
 *   - findTenantClaimsByUserId / findTenantClaimsByEmail (lib/auth-tenant-membership.ts)
 *   - loadTenantContextForUser / resolveTenantContextForSession (lib/tenant-context.ts)
 *   - ensureTenantAccessForUser (auto-provision + dev role backfill sequence)
 *
 * The Phase 1 refactor (claims consolidation + the ARIES_MULTI_WORKSPACE_ENABLED
 * fork) must keep every assertion here green WITHOUT EDITING THIS FILE: with the
 * flag OFF the consolidated helper has to emit these strings verbatim. If a
 * refactor changes any golden string, that is a flag-OFF behavior change and the
 * change is wrong, not the golden.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureTenantAccessForUser,
  findTenantClaimsByEmail,
  findTenantClaimsByUserId,
} from '../../lib/auth-tenant-membership';
import {
  loadTenantContextForUser,
  resolveTenantContextForSession,
  TenantContextError,
} from '../../lib/tenant-context';

// Pin the flag OFF for this whole file regardless of the ambient environment.
// (tsx --test runs each file in its own process, so this cannot leak.)
process.env.ARIES_MULTI_WORKSPACE_ENABLED = '0';

// ---------------------------------------------------------------------------
// Golden strings — captured verbatim from the pre-refactor implementation
// (2026-07-04, HEAD 96d365c5). Do not reformat: whitespace is part of the pin.
// ---------------------------------------------------------------------------

const GOLDEN_CLAIMS_BY_USER_ID_SQL =
  "\n      SELECT\n        u.id AS user_id,\n        u.organization_id,\n        o.id AS tenant_id,\n        CASE\n          WHEN o.id IS NULL THEN NULL\n          ELSE COALESCE(NULLIF(o.slug, ''), 'org-' || o.id::text)\n        END AS tenant_slug,\n        u.role\n      FROM users u\n      LEFT JOIN organizations o ON o.id = u.organization_id\n      WHERE u.id = $1\n      LIMIT 1\n    ";

const GOLDEN_CLAIMS_BY_EMAIL_SQL =
  "\n      SELECT\n        u.id AS user_id,\n        u.organization_id,\n        o.id AS tenant_id,\n        CASE\n          WHEN o.id IS NULL THEN NULL\n          ELSE COALESCE(NULLIF(o.slug, ''), 'org-' || o.id::text)\n        END AS tenant_slug,\n        u.role\n      FROM users u\n      LEFT JOIN organizations o ON o.id = u.organization_id\n      WHERE LOWER(u.email) = LOWER($1)\n      LIMIT 1\n    ";

const GOLDEN_ORG_SLUG_EXISTS_SQL =
  '\n      SELECT 1\n      FROM organizations\n      WHERE slug = $1\n      LIMIT 1\n    ';

const GOLDEN_ORG_INSERT_SQL =
  '\n        INSERT INTO organizations (name, slug)\n        VALUES ($1, $2)\n        RETURNING id, slug\n      ';

const GOLDEN_POINTER_UPDATE_SQL = 'UPDATE users SET organization_id = $1 WHERE id = $2';

const GOLDEN_ROLE_SELECT_SQL = 'SELECT role FROM users WHERE id = $1 LIMIT 1';

const GOLDEN_MEMBERSHIP_UPSERT_SQL =
  "\n      INSERT INTO organization_memberships\n        (user_id, organization_id, role, status, invited_by_user_id,\n         invited_at, accepted_at, last_active_at, created_at, updated_at)\n      VALUES (\n        $1, $2, $3, $4, $5,\n        CASE WHEN $4 = 'invited' THEN now() ELSE NULL END,\n        CASE WHEN $4 = 'active'  THEN now() ELSE NULL END,\n        CASE WHEN $4 = 'active'  THEN now() ELSE NULL END,\n        now(), now()\n      )\n      ON CONFLICT (user_id, organization_id) DO UPDATE SET\n        role = EXCLUDED.role,\n        status = EXCLUDED.status,\n        accepted_at = CASE\n          WHEN EXCLUDED.status = 'active'\n          THEN COALESCE(organization_memberships.accepted_at, now())\n          ELSE organization_memberships.accepted_at\n        END,\n        last_active_at = CASE\n          WHEN EXCLUDED.status = 'active'\n          THEN COALESCE(organization_memberships.last_active_at, now())\n          ELSE organization_memberships.last_active_at\n        END,\n        updated_at = now()\n    ";

const GOLDEN_ROLE_UPDATE_SQL = 'UPDATE users SET role = $1 WHERE id = $2';

// ---------------------------------------------------------------------------
// Recording fixtures
// ---------------------------------------------------------------------------

type Call = { sql: string; params: unknown[] };

function recordingQueryable(
  respond: (sql: string, params: unknown[]) => { rowCount: number | null; rows: Array<Record<string, unknown>> },
) {
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

const FULL_CLAIMS_ROW = {
  user_id: '42',
  organization_id: '7',
  tenant_id: '7',
  tenant_slug: 'acme-co',
  role: 'tenant_admin',
};

// ---------------------------------------------------------------------------
// findTenantClaimsByUserId / findTenantClaimsByEmail
// ---------------------------------------------------------------------------

test('golden: findTenantClaimsByUserId sends the exact legacy SQL + numeric param and returns the row verbatim', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [{ ...FULL_CLAIMS_ROW }] }));

  const row = await findTenantClaimsByUserId(queryable as never, '42');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, GOLDEN_CLAIMS_BY_USER_ID_SQL);
  assert.deepEqual(calls[0].params, [42]);
  assert.deepEqual(row, FULL_CLAIMS_ROW);
});

test('golden: findTenantClaimsByUserId returns null (not throw) on zero rows', async () => {
  const { queryable } = recordingQueryable(() => ({ rowCount: 0, rows: [] }));
  assert.equal(await findTenantClaimsByUserId(queryable as never, 42), null);
});

test('golden: findTenantClaimsByEmail sends the exact legacy SQL with the email passed through UNNORMALIZED', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [{ ...FULL_CLAIMS_ROW }] }));

  const row = await findTenantClaimsByEmail(queryable as never, 'Mixed.Case@Example.COM');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, GOLDEN_CLAIMS_BY_EMAIL_SQL);
  // Normalization happens in SQL (LOWER($1)) — the raw value must go over the
  // wire untouched, exactly as today.
  assert.deepEqual(calls[0].params, ['Mixed.Case@Example.COM']);
  assert.deepEqual(row, FULL_CLAIMS_ROW);
});

test('golden: findTenantClaimsByEmail returns null on zero rows', async () => {
  const { queryable } = recordingQueryable(() => ({ rowCount: 0, rows: [] }));
  assert.equal(await findTenantClaimsByEmail(queryable as never, 'nobody@example.com'), null);
});

test('golden: incomplete rows (null org) are returned as-is by the claims helpers — the CALLER decides', async () => {
  const incomplete = { user_id: '42', organization_id: null, tenant_id: null, tenant_slug: null, role: null };
  const { queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [{ ...incomplete }] }));
  assert.deepEqual(await findTenantClaimsByUserId(queryable as never, 42), incomplete);
});

// ---------------------------------------------------------------------------
// loadTenantContextForUser — must ride the byte-identical query
// ---------------------------------------------------------------------------

test('golden: loadTenantContextForUser sends the byte-identical by-user-id SQL and maps the row', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [{ ...FULL_CLAIMS_ROW }] }));

  const context = await loadTenantContextForUser(queryable as never, '42');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, GOLDEN_CLAIMS_BY_USER_ID_SQL);
  assert.deepEqual(calls[0].params, [42]);
  assert.deepEqual(context, {
    userId: '42',
    tenantId: '7',
    tenantSlug: 'acme-co',
    role: 'tenant_admin',
  });
});

test('golden: loadTenantContextForUser throws tenant_membership_missing on zero rows', async () => {
  const { queryable } = recordingQueryable(() => ({ rowCount: 0, rows: [] }));

  await assert.rejects(
    () => loadTenantContextForUser(queryable as never, '42'),
    (error: unknown) => {
      assert.ok(error instanceof TenantContextError);
      assert.equal(error.reason, 'tenant_membership_missing');
      assert.equal(error.message, 'No tenant membership found for authenticated user.');
      assert.deepEqual(error.missingClaims, []);
      return true;
    },
  );
});

test('golden: loadTenantContextForUser throws tenant_claims_incomplete with the exact message + missing list', async () => {
  const { queryable } = recordingQueryable(() => ({
    rowCount: 1,
    rows: [{ user_id: '42', organization_id: null, tenant_id: null, tenant_slug: null, role: null }],
  }));

  await assert.rejects(
    () => loadTenantContextForUser(queryable as never, '42'),
    (error: unknown) => {
      assert.ok(error instanceof TenantContextError);
      assert.equal(error.reason, 'tenant_claims_incomplete');
      assert.equal(
        error.message,
        'Authenticated user is missing required tenant claims: organization_id, tenant_id, tenant_slug, role.',
      );
      assert.deepEqual(error.missingClaims, ['organization_id', 'tenant_id', 'tenant_slug', 'role']);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// resolveTenantContextForSession — DB-first, claims only as outage fallback
// ---------------------------------------------------------------------------

const SESSION_WITH_STALE_CLAIMS = {
  user: { id: '42', tenantId: '7', tenantSlug: 'old-workspace', role: 'tenant_admin' as const },
  expires: '2099-01-01T00:00:00.000Z',
};

test('golden: resolveTenantContextForSession prefers the DB row over session claims (single query, exact SQL)', async () => {
  const { calls, queryable } = recordingQueryable(() => ({
    rowCount: 1,
    rows: [{ user_id: '42', organization_id: '8', tenant_id: '8', tenant_slug: 'framex-studio', role: 'tenant_admin' }],
  }));

  const context = await resolveTenantContextForSession(queryable as never, SESSION_WITH_STALE_CLAIMS);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, GOLDEN_CLAIMS_BY_USER_ID_SQL);
  assert.deepEqual(context, { userId: '42', tenantId: '8', tenantSlug: 'framex-studio', role: 'tenant_admin' });
});

test('golden: resolveTenantContextForSession rethrows TenantContextError (no stale-claims fallback)', async () => {
  const { queryable } = recordingQueryable(() => ({ rowCount: 0, rows: [] }));

  await assert.rejects(
    () => resolveTenantContextForSession(queryable as never, SESSION_WITH_STALE_CLAIMS),
    TenantContextError,
  );
});

test('golden: resolveTenantContextForSession falls back to session claims on transient (non-context) errors', async () => {
  const queryable = {
    async query() {
      throw new Error('database temporarily unavailable');
    },
  };

  const context = await resolveTenantContextForSession(queryable as never, SESSION_WITH_STALE_CLAIMS);

  assert.deepEqual(context, { userId: '42', tenantId: '7', tenantSlug: 'old-workspace', role: 'tenant_admin' });
});

// ---------------------------------------------------------------------------
// ensureTenantAccessForUser — the flag-OFF auto-provision sequence, pinned
// call-for-call (SQL bytes + params + ordering).
// ---------------------------------------------------------------------------

function ensureRespond(orgId: number) {
  return (sql: string, params: unknown[]) => {
    if (/FROM organizations/.test(sql) && /WHERE slug/.test(sql)) {
      return { rowCount: 0, rows: [] };
    }
    if (/INSERT INTO organizations/.test(sql)) {
      return { rowCount: 1, rows: [{ id: orgId, slug: params[1] as string }] };
    }
    if (sql === GOLDEN_ROLE_SELECT_SQL) {
      return { rowCount: 1, rows: [{ role: 'tenant_admin' }] };
    }
    return { rowCount: 1, rows: [] };
  };
}

test('golden: ensureTenantAccessForUser (dev, no org) emits the exact 6-call provisioning sequence', async () => {
  const { calls, queryable } = recordingQueryable(ensureRespond(6));

  await ensureTenantAccessForUser(
    queryable as never,
    { userId: 6, organizationId: null, role: null, name: 'Jane Doe', email: 'jane@example.com' },
    { NODE_ENV: 'development' } as NodeJS.ProcessEnv,
  );

  assert.deepEqual(calls, [
    { sql: GOLDEN_ORG_SLUG_EXISTS_SQL, params: ['jane-doe'] },
    { sql: GOLDEN_ORG_INSERT_SQL, params: ['Jane Doe', 'jane-doe'] },
    { sql: GOLDEN_POINTER_UPDATE_SQL, params: [6, 6] },
    { sql: GOLDEN_ROLE_SELECT_SQL, params: [6] },
    { sql: GOLDEN_MEMBERSHIP_UPSERT_SQL, params: [6, 6, 'tenant_admin', 'active', null] },
    { sql: GOLDEN_ROLE_UPDATE_SQL, params: ['tenant_admin', 6] },
  ]);
});

test('golden: ensureTenantAccessForUser (prod, no org) emits the same sequence minus the dev role backfill', async () => {
  const { calls, queryable } = recordingQueryable(ensureRespond(12));

  await ensureTenantAccessForUser(
    queryable as never,
    { userId: 12, organizationId: null, role: null, name: 'Prod User', email: 'prod@example.com' },
    { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
  );

  assert.deepEqual(calls, [
    { sql: GOLDEN_ORG_SLUG_EXISTS_SQL, params: ['prod-user'] },
    { sql: GOLDEN_ORG_INSERT_SQL, params: ['Prod User', 'prod-user'] },
    { sql: GOLDEN_POINTER_UPDATE_SQL, params: [12, 12] },
    { sql: GOLDEN_ROLE_SELECT_SQL, params: [12] },
    { sql: GOLDEN_MEMBERSHIP_UPSERT_SQL, params: [12, 12, 'tenant_admin', 'active', null] },
  ]);
});

test('golden: ensureTenantAccessForUser is a ZERO-QUERY no-op when org + valid role are present', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [] }));

  await ensureTenantAccessForUser(
    queryable as never,
    { userId: 6, organizationId: 7, role: 'tenant_admin', name: 'Jane', email: 'jane@example.com' },
    { NODE_ENV: 'development' } as NodeJS.ProcessEnv,
  );

  assert.deepEqual(calls, []);
});

test('golden: ensureTenantAccessForUser (dev, org present, invalid role) emits ONLY the role backfill', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [] }));

  await ensureTenantAccessForUser(
    queryable as never,
    { userId: 6, organizationId: 7, role: 'platform_owner', name: 'Jane', email: 'jane@example.com' },
    { NODE_ENV: 'development' } as NodeJS.ProcessEnv,
  );

  assert.deepEqual(calls, [{ sql: GOLDEN_ROLE_UPDATE_SQL, params: ['tenant_admin', 6] }]);
});

test('golden: ensureTenantAccessForUser (prod, org present, invalid role) is a zero-query no-op', async () => {
  const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [] }));

  await ensureTenantAccessForUser(
    queryable as never,
    { userId: 6, organizationId: 7, role: null, name: 'Jane', email: 'jane@example.com' },
    { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
  );

  assert.deepEqual(calls, []);
});
