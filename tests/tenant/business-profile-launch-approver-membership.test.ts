/**
 * Multi-workspace Phase 4 — launch_approver_user_id membership assertion
 * (business-profile.ts ~:440-450, plan "Also in the blast radius").
 *
 * Writers of launch_approver_user_id must assert the approver actually belongs
 * to the workspace (an active membership OR — dark-period drift tolerance — the
 * legacy active pointer). Historically the id was trusted in-tenant with no
 * membership check. The assertion fires ONLY when the approver is being newly
 * set/changed to a non-null value, so an unchanged update never re-validates
 * and no stored profile can be broken by drift; the Phase-0 backfill created an
 * active membership for every current member, so every valid existing approver
 * passes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { updateBusinessProfileWithDiagnostics } from '../../backend/tenant/business-profile';

type Handler = (params: unknown[]) => { rows: Array<Record<string, unknown>>; rowCount?: number | null };

function makeClient(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const lowered = sql.toLowerCase();
      for (const [pattern, handler] of routes) {
        if (pattern.test(lowered)) return handler(params);
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

const ORG_SELECT_RE = /select id, name, coalesce\(nullif\(slug/;
const ORG_UPDATE_RE = /update organizations set name = \$1 where id = \$2/;
const APPROVER_CHECK_RE = /from users u\s+where u\.id = \$1/;

function withTempDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.DATA_ROOT;
  const temp = mkdtempSync(path.join(os.tmpdir(), 'aries-launch-approver-'));
  process.env.DATA_ROOT = temp;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    rmSync(temp, { force: true, recursive: true });
  });
}

test('rejects a launch approver who is NOT a member of the workspace', async () => {
  await withTempDataRoot(async () => {
    const { client, calls } = makeClient([
      [ORG_SELECT_RE, () => ({ rows: [{ id: 11, name: 'Acme', slug: 'org-11' }], rowCount: 1 })],
      // approverBelongsToTenant → no active membership + wrong pointer → 0 rows.
      [APPROVER_CHECK_RE, () => ({ rows: [], rowCount: 0 })],
      [ORG_UPDATE_RE, () => ({ rows: [], rowCount: 1 })],
    ]);

    await assert.rejects(
      () =>
        updateBusinessProfileWithDiagnostics(client as never, {
          tenantId: '11',
          businessName: 'Acme',
          launchApproverUserId: '999',
        }),
      /invalid_launch_approver/,
    );

    // The membership assertion ran with the approver id + tenant id, and the
    // profile write (organizations UPDATE) never happened.
    const check = calls.find((c) => APPROVER_CHECK_RE.test(c.sql.toLowerCase()));
    assert.ok(check, 'the membership assertion query ran');
    assert.deepEqual(check!.params, [999, 11]);
    assert.ok(!calls.some((c) => ORG_UPDATE_RE.test(c.sql.toLowerCase())), 'no profile write on a rejected approver');
  });
});

test('accepts a launch approver who IS an active member of the workspace', async () => {
  await withTempDataRoot(async () => {
    const { client, calls } = makeClient([
      [ORG_SELECT_RE, () => ({ rows: [{ id: 11, name: 'Acme', slug: 'org-11' }], rowCount: 1 })],
      // approverBelongsToTenant → an active membership exists → 1 row.
      [APPROVER_CHECK_RE, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })],
      [ORG_UPDATE_RE, () => ({ rows: [], rowCount: 1 })],
    ]);

    await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId: '11',
      businessName: 'Acme',
      launchApproverUserId: '42',
    });

    const check = calls.find((c) => APPROVER_CHECK_RE.test(c.sql.toLowerCase()));
    assert.ok(check, 'the membership assertion query ran');
    assert.deepEqual(check!.params, [42, 11]);
    assert.ok(calls.some((c) => ORG_UPDATE_RE.test(c.sql.toLowerCase())), 'the profile write proceeds for a valid approver');
  });
});

test('does NOT re-validate when the approver is not being set (unchanged update cannot break stored data)', async () => {
  await withTempDataRoot(async () => {
    const { client, calls } = makeClient([
      [ORG_SELECT_RE, () => ({ rows: [{ id: 11, name: 'Acme', slug: 'org-11' }], rowCount: 1 })],
      [ORG_UPDATE_RE, () => ({ rows: [], rowCount: 1 })],
    ]);

    // No launchApproverUserId in the input → the assertion never runs.
    await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId: '11',
      businessName: 'Acme Renamed',
    });

    assert.ok(
      !calls.some((c) => APPROVER_CHECK_RE.test(c.sql.toLowerCase())),
      'no membership assertion when the approver field is absent',
    );
  });
});

test('the rejection is a TYPED error (route → 400 invalid_launch_approver), never an uncaught 500', async () => {
  await withTempDataRoot(async () => {
    const { client } = makeClient([
      [ORG_SELECT_RE, () => ({ rows: [{ id: 11, name: 'Acme', slug: 'org-11' }], rowCount: 1 })],
      [APPROVER_CHECK_RE, () => ({ rows: [], rowCount: 0 })],
      [ORG_UPDATE_RE, () => ({ rows: [], rowCount: 1 })],
    ]);

    // The failure must be the exact typed message the route maps to a 400 — so
    // the caller can distinguish it from a database/500 fault.
    await assert.rejects(
      () =>
        updateBusinessProfileWithDiagnostics(client as never, {
          tenantId: '11',
          businessName: 'Acme',
          launchApproverUserId: '999',
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).message, 'invalid_launch_approver', 'exact typed error, not a raw 500');
        return true;
      },
    );
  });
});

test('the membership assertion accepts EITHER an active membership OR the legacy active pointer (drift tolerance)', async () => {
  await withTempDataRoot(async () => {
    // Assert the assertion query itself encodes BOTH acceptance branches: an
    // active organization_memberships row OR the legacy users.organization_id
    // pointer. This pins the dark-period drift tolerance the plan requires (a
    // backfilled member OR a pre-backfill pointer-only member both pass) without
    // needing to distinguish the OR arms at the mock level.
    const { client, calls } = makeClient([
      [ORG_SELECT_RE, () => ({ rows: [{ id: 11, name: 'Acme', slug: 'org-11' }], rowCount: 1 })],
      [APPROVER_CHECK_RE, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })],
      [ORG_UPDATE_RE, () => ({ rows: [], rowCount: 1 })],
    ]);

    await updateBusinessProfileWithDiagnostics(client as never, {
      tenantId: '11',
      businessName: 'Acme',
      launchApproverUserId: '42',
    });

    const check = calls.find((c) => APPROVER_CHECK_RE.test(c.sql.toLowerCase()));
    assert.ok(check, 'the membership assertion query ran');
    const sql = check!.sql.toLowerCase();
    assert.match(sql, /from organization_memberships m/, 'checks an active membership');
    assert.match(sql, /m\.status = 'active'/, 'the membership branch requires status active');
    assert.match(sql, /or u\.organization_id = \$2/, 'the legacy active-pointer fallback branch is present (drift tolerance)');
  });
});
