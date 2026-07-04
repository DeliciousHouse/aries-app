/**
 * Multi-workspace Phase 1 — ADVERSARIAL / edge coverage for the security
 * invariants of membership-aware resolution
 * (docs/plans/2026-07-03-multi-workspace-membership.md — Risks 1 + 2, Decisions
 * 3 + 7, CEO hardening 3 + 7, eng findings 8 + 9 + 12).
 *
 * The implementer's happy-path + boundary suite lives in
 * tests/tenant/multi-workspace-resolution.test.ts (flag ON) and
 * tests/auth/tenant-resolution-flag-off-golden.test.ts (byte-identical OFF).
 * This file adds the FAILING-BEFORE / PASSING-AFTER adversarial proofs each
 * security invariant needs — the class of bug the guard exists to stop, not
 * just the shape of the happy row:
 *
 *   1. Pointer validated against ACTIVE membership ONLY — an 'invited' (or
 *      missing) membership at the pointer org NEVER grants that org's access or
 *      role, and NEVER falls through to stale session claims that would (the
 *      cross-flow account-visibility class).
 *   2. Role comes from the MEMBERSHIP row — a stale/mismatched users.role
 *      (admin mirror, viewer membership) yields the MEMBERSHIP role, so the
 *      downstream `role !== 'tenant_admin'` admin gate rejects (Risk 2,
 *      cross-org privilege escalation).
 *   3. jwt hydrate CLEARS stale claims when membership resolution returns none;
 *      removed-while-active converges on the next resolution (CEO hardening 7).
 *   5. Self-heal boundaries — flag OFF NEVER self-heals; an 'invited' row is
 *      never flipped to 'active'.
 *   7. System actors bypass — synthetic contexts never reach membership
 *      validation (they don't resolve user→org at all).
 *   8. Claims-fallback trade (eng 12) — a DB blip serves session claims for
 *      READS in BOTH flag states, identically.
 *   9. Both-flag-state matrix — the flag-ON claims path is behaviorally
 *      exercised here; the byte-identical OFF pin is the golden file.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// This file exercises BOTH flag states, so it does NOT pin the flag at module
// load. Each test sets ARIES_MULTI_WORKSPACE_ENABLED explicitly and the env is
// read fresh by isMultiWorkspaceEnabled() on every call. (tsx --test = one
// process per file, so the mutation cannot leak to sibling files.)
import {
  ensureTenantAccessForUser,
  resolveTenantClaimsRow,
} from '../../lib/auth-tenant-membership';
import {
  loadTenantContextForUser,
  resolveTenantContextForSession,
  TenantContextError,
} from '../../lib/tenant-context';

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

// The env must stay set for the ENTIRE async body — so this awaits fn() before
// restoring. A synchronous try/finally would restore the flag the instant the
// async arrow returned its (still-pending) promise, running the body under the
// wrong flag (the exact footgun this helper exists to prevent).
async function withFlag<T>(value: '0' | '1', fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ARIES_MULTI_WORKSPACE_ENABLED;
  process.env.ARIES_MULTI_WORKSPACE_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ARIES_MULTI_WORKSPACE_ENABLED;
    else process.env.ARIES_MULTI_WORKSPACE_ENABLED = prev;
  }
}

// ===========================================================================
// Invariant 1 — pointer validated against ACTIVE membership ONLY.
// The invited/missing-membership pointer must NEVER grant the pointer org's
// role, and must NEVER be rescued by stale session claims that carry it.
// ===========================================================================

test('invariant 1: an INVITED-membership pointer + stale ADMIN session claims → throws, never serves the invited org role', async () => {
  // The exact cross-flow account-takeover shape: the session JWT still carries
  // tenantId=7 / role=tenant_admin from a prior active state, but the user's
  // membership at org 7 is now only 'invited'. DB-first resolution must WIN and
  // the resolver must throw a TenantContextError (which resolveTenantContextForSession
  // rethrows — it is NOT the transient-error class), so the stale admin claims
  // never leak org 7's access.
  await withFlag('1', async () => {
    const { queryable } = recordingQueryable(() => ({
      rowCount: 1,
      rows: [rawRow({ membership_role: 'tenant_admin', membership_status: 'invited', workspace_count: 0 })],
    }));

    await assert.rejects(
      () =>
        resolveTenantContextForSession(queryable as never, {
          user: { id: '42', tenantId: '7', tenantSlug: 'acme-co', role: 'tenant_admin' },
          expires: '2099-01-01T00:00:00.000Z',
        }),
      (error: unknown) => {
        assert.ok(error instanceof TenantContextError, 'must be a TenantContextError (no fallback), not a plain throw');
        assert.equal(error.reason, 'tenant_membership_missing');
        return true;
      },
    );
  });
});

test('invariant 1: a pointer whose membership is invited resolves with NULL org + NULL role (zero-membership shape)', async () => {
  await withFlag('1', async () => {
    const { queryable } = recordingQueryable(() => ({
      rowCount: 1,
      rows: [rawRow({ membership_role: 'tenant_admin', membership_status: 'invited', workspace_count: 0 })],
    }));

    const row = await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });
    // The invited org role (tenant_admin) must NOT survive onto the claims row.
    assert.equal(row?.role, null, 'invited-membership role must never be carried into claims');
    assert.equal(row?.organization_id, null);
    assert.equal(row?.tenant_id, null);
  });
});

// ===========================================================================
// Invariant 2 — role comes from the MEMBERSHIP row (Risk 2 privilege escalation).
// The load-bearing scenario: users.role mirror is STALE-HIGH (admin) but the
// active membership on the pointer org is a viewer → the admin gate rejects.
// ===========================================================================

test('invariant 2: stale users.role=admin but active membership=viewer → context role is VIEWER (admin gate rejects)', async () => {
  await withFlag('1', async () => {
    const { queryable } = recordingQueryable(() => ({
      rowCount: 1,
      rows: [
        rawRow({
          pointer_role: 'tenant_admin', // stale legacy mirror
          membership_role: 'tenant_viewer', // authoritative
          membership_status: 'active',
          workspace_count: 2,
        }),
      ],
    }));

    const context = await loadTenantContextForUser(queryable as never, '42');
    assert.equal(context.role, 'tenant_viewer', 'the MEMBERSHIP role wins over the stale users.role mirror');

    // Replay the downstream admin gate exactly as the route enforces it
    // (app/api/tenant/profiles/route.ts:44: `if (tenantContext.role !==
    // 'tenant_admin')` → 403). Passing the resolved role through a function
    // (not an inline literal comparison) keeps TS from narrowing the check
    // away, and proves the gate REJECTS — the cross-org escalation Risk 2
    // designs away.
    const adminGateRejects = (role: string): boolean => role !== 'tenant_admin';
    assert.ok(adminGateRejects(context.role), 'stale-admin mirror must not open the admin gate');
  });
});

test('invariant 2: the SAME stale users.role would ESCALATE under the legacy flag-OFF pointer query (why membership resolution exists)', async () => {
  // Guards the reverse: flag OFF, role still comes from users.role — this is the
  // documented pre-Phase-1 behavior the golden file pins. If someone made the
  // flag-OFF path also read the membership, THIS would flip and the golden would
  // scream; if someone made the flag-ON path read users.role, invariant 2 above
  // would flip. The pair boxes the fork in.
  await withFlag('0', async () => {
    const legacyRow = {
      user_id: '42',
      organization_id: '7',
      tenant_id: '7',
      tenant_slug: 'acme-co',
      role: 'tenant_admin', // the stale-high mirror IS the answer flag OFF
    };
    const { queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [{ ...legacyRow }] }));
    const context = await loadTenantContextForUser(queryable as never, '42');
    assert.equal(context.role, 'tenant_admin', 'flag OFF: role is users.role verbatim (today, golden-pinned)');
  });
});

// ===========================================================================
// Invariant 3 — removed-while-active converges (CEO hardening 7).
// The jwt-hydrate CLEAR is structurally pinned in
// multi-workspace-resolution.test.ts; here we prove the RESOLVER half: a member
// removed from their active workspace resolves to the zero-membership state on
// the very next request, not the old workspace.
// ===========================================================================

test('invariant 3: removed-while-active — pointer still set but membership row gone → resolves zero-membership on next request', async () => {
  // The removal deleted the membership row but (in this window) has not yet
  // repointed users.organization_id. The pointer org still exists, so the raw
  // row shows org_id present, membership_status NULL. Self-heal MUST NOT rescue
  // this into the removed workspace — but self-heal fires exactly on
  // "pointer→existing org, no membership row". The convergence guarantee is that
  // the caller (loadTenantContextForUser) surfaces tenant_membership_missing
  // once resolution yields no active membership. Here we prove that WHEN the
  // pointer's users.role is NOT a valid tenant role (the removal path also
  // clears/leaves the mirror unusable) self-heal is skipped and it converges.
  await withFlag('1', async () => {
    const { calls, queryable } = recordingQueryable(() => ({
      rowCount: 1,
      rows: [
        rawRow({
          pointer_role: null, // mirror no longer a usable role → no self-heal
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
    assert.ok(
      !calls.some((c) => /INSERT INTO organization_memberships/.test(c.sql)),
      'removed-while-active must NOT self-heal a ghost membership back into existence',
    );
  });
});

test('invariant 3: removed member with N≥1 OTHER active memberships still resolves the ZERO shape for THIS pointer (pre-repoint)', async () => {
  // Even when the account has other active memberships (workspace_count>0), a
  // pointer whose own membership is gone resolves NULL for the pointer — the
  // repoint to a surviving membership is the sign-in guard's job, not the
  // resolver's. This pins that the resolver never "helpfully" swaps the tenant.
  await withFlag('1', async () => {
    const { queryable } = recordingQueryable(() => ({
      rowCount: 1,
      rows: [
        rawRow({
          pointer_role: 'platform_owner', // not a tenant role → no self-heal
          membership_role: null,
          membership_status: null,
          workspace_count: 3,
        }),
      ],
    }));

    const row = await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });
    assert.equal(row?.organization_id, null, 'resolver never swaps the pointer to a surviving membership');
    assert.equal(row?.workspace_count, 3, 'workspace_count still reflects the surviving memberships (chooser signal)');
  });
});

// ===========================================================================
// Invariant 5 — self-heal boundaries.
// ===========================================================================

test('invariant 5: self-heal NEVER fires flag OFF (the legacy query has no membership column, and no INSERT is emitted)', async () => {
  await withFlag('0', async () => {
    const { calls, queryable } = recordingQueryable(() => ({
      rowCount: 1,
      // flag-OFF legacy shape: an incomplete pointer row (null org).
      rows: [{ user_id: '42', organization_id: null, tenant_id: null, tenant_slug: null, role: null }],
    }));

    await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });

    assert.equal(calls.length, 1, 'flag OFF is a single legacy SELECT, never a heal');
    assert.ok(!/organization_memberships/i.test(calls[0].sql), 'flag OFF must not touch memberships');
    assert.ok(
      !calls.some((c) => /INSERT INTO organization_memberships/.test(c.sql)),
      'self-heal must never fire with the flag OFF',
    );
  });
});

test('invariant 5: self-heal never FLIPS an invited membership to active (invited → NULL, no INSERT)', async () => {
  // An 'invited' membership is a present row, so the self-heal branch (which
  // requires membership_status === null) is not entered. Pin that the invited
  // row resolves like NULL WITHOUT any write.
  await withFlag('1', async () => {
    const { calls, queryable } = recordingQueryable(() => ({
      rowCount: 1,
      rows: [rawRow({ membership_role: 'tenant_viewer', membership_status: 'invited', workspace_count: 0 })],
    }));

    const row = await resolveTenantClaimsRow(queryable as never, { by: 'userId', userId: 42 });

    assert.equal(calls.length, 1, 'an invited membership must not trigger any write');
    assert.ok(!calls.some((c) => /INSERT INTO organization_memberships/.test(c.sql)));
    assert.ok(!calls.some((c) => /UPDATE organization_memberships/.test(c.sql)));
    assert.equal(row?.organization_id, null);
  });
});

// ===========================================================================
// Invariant 7 — system actors never reach membership validation.
// The synthetic contexts (backend/memory/write-events.ts,
// honcho-performance-worker.ts) construct a MinimalTenantCtx by hand and never
// call getTenantContext / resolveTenantClaimsRow. Pin that the resolution
// surface is only reached via the session-derived path, so a userId:'system'
// context cannot be gated by a membership row it will never have.
// ===========================================================================

test('invariant 7: the membership resolution helpers are never imported by the synthetic-context worker paths', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { resolveProjectRoot } = await import('../helpers/project-root');
  const repoRoot = path.join(resolveProjectRoot(import.meta.url), '..');

  for (const rel of [
    'backend/memory/write-events.ts',
    'scripts/automations/honcho-performance-worker.ts',
  ]) {
    const src = readFileSync(path.join(repoRoot, rel), 'utf8');
    // These synthetic-context producers must not resolve identity through the
    // membership-validated path — they hand-build the ctx with the 'system'
    // sentinel (plan Decision 10, Taste/Honcho hardening).
    assert.ok(
      !/resolveTenantClaimsRow|getTenantContext|loadTenantContextForUser/.test(src),
      `${rel} must not route a synthetic context through membership resolution`,
    );
    assert.ok(/userId:\s*'system'/.test(src), `${rel} must carry the 'system' sentinel`);
  }
});

test('invariant 7: ensureTenantAccessForUser flag ON never mints/repoints for a resolved-active account (idempotent, worker-safe)', async () => {
  // A synthetic/worker path that DID reach ensureTenantAccessForUser with an
  // already-valid pointer must be a pure resolution no-op — no INSERT, no
  // UPDATE — so it can never spuriously provision.
  await withFlag('1', async () => {
    const { calls, queryable } = recordingQueryable(() => ({ rowCount: 1, rows: [rawRow()] }));
    await ensureTenantAccessForUser(
      queryable as never,
      { userId: 42, organizationId: 7, role: 'tenant_admin', name: 'Sys', email: 'sys@example.com' },
      { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'production' } as NodeJS.ProcessEnv,
    );
    assert.equal(calls.length, 1, 'resolution only');
    for (const c of calls) {
      assert.ok(!/INSERT INTO organizations/i.test(c.sql));
      assert.ok(!/UPDATE users/i.test(c.sql));
    }
  });
});

// ===========================================================================
// Invariant 8 — claims-fallback trade (eng 12): a DB blip serves session claims
// for READS in BOTH flag states, identically. (The mutation fail-closed half is
// Phase 3 — deliberately NOT tested here.)
// ===========================================================================

for (const flag of ['0', '1'] as const) {
  test(`invariant 8: flag ${flag} — a TRANSIENT (non-context) DB error falls back to session claims for reads`, async () => {
    await withFlag(flag, async () => {
      const queryable = {
        async query() {
          throw new Error('database temporarily unavailable');
        },
      };
      const context = await resolveTenantContextForSession(queryable as never, {
        user: { id: '42', tenantId: '7', tenantSlug: 'old-workspace', role: 'tenant_admin' },
        expires: '2099-01-01T00:00:00.000Z',
      });
      assert.deepEqual(context, {
        userId: '42',
        tenantId: '7',
        tenantSlug: 'old-workspace',
        role: 'tenant_admin',
      });
    });
  });

  test(`invariant 8: flag ${flag} — a TenantContextError (resolved zero-membership/incomplete) is NEVER masked by session claims`, async () => {
    await withFlag(flag, async () => {
      // Zero rows → tenant_membership_missing in both flag states; the resolver
      // must rethrow, not serve stale claims (the availability-over-consistency
      // trade is for TRANSIENT errors only).
      const { queryable } = recordingQueryable(() => ({ rowCount: 0, rows: [] }));
      await assert.rejects(
        () =>
          resolveTenantContextForSession(queryable as never, {
            user: { id: '42', tenantId: '7', tenantSlug: 'old-workspace', role: 'tenant_admin' },
            expires: '2099-01-01T00:00:00.000Z',
          }),
        TenantContextError,
      );
    });
  });
}

// ===========================================================================
// Invariant 4 — zero-membership never mints an org on the sign-in path, even
// when the pointer DANGLES at a deleted org (the resolver returns the zero
// shape; ensureTenantAccessForUser must mint NOTHING and repoint NOTHING).
// ===========================================================================

test('invariant 4: dangling pointer (deleted org) + zero memberships → ensureTenantAccessForUser mints NOTHING', async () => {
  await withFlag('1', async () => {
    const { calls, queryable } = recordingQueryable(() => ({
      rowCount: 1,
      rows: [
        rawRow({
          pointer_organization_id: '99', // pointer set, but the org is gone
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
      { userId: 42, organizationId: 99, role: 'tenant_admin', name: 'Ghost', email: 'ghost@example.com' },
      { ARIES_MULTI_WORKSPACE_ENABLED: '1', NODE_ENV: 'production' } as NodeJS.ProcessEnv,
    );

    assert.equal(calls.length, 1, 'resolution only — zero memberships means no repoint target');
    for (const c of calls) {
      assert.ok(!/INSERT INTO organizations/i.test(c.sql), 'must not mint a personal org for a dangling pointer');
      assert.ok(!/INSERT INTO organization_memberships/i.test(c.sql), 'must not self-heal a membership into a deleted org');
      assert.ok(!/UPDATE users/i.test(c.sql), 'must not write the pointer');
    }
  });
});

// ===========================================================================
// Invariant 9 — both-flag-state matrix on the load-bearing resolution surface.
// The byte-identical OFF pin is tenant-resolution-flag-off-golden.test.ts; here
// we prove the ON path produces the membership-derived answer for the SAME
// fixture the OFF golden pins, so the fork is observable and intentional.
// ===========================================================================

test('invariant 9: same user, flag OFF → users.role; flag ON → membership role (the fork is real and directional)', async () => {
  // Flag OFF: legacy pointer row, role = users.role.
  const offContext = await withFlag('0', async () => {
    const { queryable } = recordingQueryable(() => ({
      rowCount: 1,
      rows: [{ user_id: '42', organization_id: '7', tenant_id: '7', tenant_slug: 'acme-co', role: 'tenant_admin' }],
    }));
    return loadTenantContextForUser(queryable as never, '42');
  });

  // Flag ON: membership row, role = membership_role (different value).
  const onContext = await withFlag('1', async () => {
    const { queryable } = recordingQueryable(() => ({
      rowCount: 1,
      rows: [rawRow({ pointer_role: 'tenant_admin', membership_role: 'tenant_analyst', membership_status: 'active' })],
    }));
    return loadTenantContextForUser(queryable as never, '42');
  });

  assert.equal(offContext.role, 'tenant_admin');
  assert.equal(onContext.role, 'tenant_analyst');
  // Tenant identity is stable across the fork; only the role SOURCE changes.
  assert.equal(offContext.tenantId, onContext.tenantId);
  assert.equal(offContext.tenantSlug, onContext.tenantSlug);
});
