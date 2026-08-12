/**
 * tests/marketing/auto-publish-gate.test.ts
 *
 * Owner-gated auto-publish — self-contained coverage (no DB).
 *
 * Auto-schedule and auto-publish used to be the same action: a scheduled row
 * became live with no human step. This suite pins the four pieces that split
 * them:
 *
 *   1. The fleet-wide kill switch parses the repo's canonical 4-token idiom.
 *   2. The store treats a MISSING row as disabled (held), and upserts rather
 *      than updates so the first flip is not a silent no-op.
 *   3. The PATCH route is tenant_admin-only and rejects a body that does not
 *      carry an explicit boolean.
 *   4. The admit predicate is present in ALL THREE worker statements and
 *      qualifies its outer tenant_id — the correlated-subquery footgun that
 *      would silently hold the gate open.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/auto-publish-gate.test.ts
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Pool } from 'pg';

import { isAutoPublishGateEnabled } from '../../backend/marketing/auto-publish-env';
import {
  getAutoPublishSettingForTenant,
  setAutoPublishEnabledForTenant,
} from '../../backend/marketing/auto-publish-store';
import { handleGetAutoPublish, handlePatchAutoPublish } from '../../app/api/marketing/auto-publish/handler';
import { TenantContextError, type TenantContext } from '../../lib/tenant-context';
import type { TenantContextLoader } from '../../lib/tenant-context-http';

// The worker is plain `.mjs` with no declaration file; the repo's convention for
// reaching into it from a TS test is a dynamic import through pathToFileURL
// (see tests/scheduled-post-partial-dispatch.test.ts).
type WorkerModule = {
  CLAIM_ROW_SQL: string;
  DUE_ROWS_SQL: string;
  SWEEP_DEAD_CAMPAIGN_SQL: string;
  autoPublishAdmitSql: (alias: string, param: string) => string;
  isAutoPublishGateEnabled: (env?: Record<string, string | undefined>) => boolean;
};

// `../..` — this file lives one directory deeper than tests/, so the shared
// resolveProjectRoot helper (which climbs exactly one level) would land on
// tests/. Same form as tests/marketing/taste-tenant-scoped.requires-infra.test.ts.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function loadWorker(): Promise<WorkerModule> {
  return (await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs')).href
  )) as unknown as WorkerModule;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Call = { sql: string; params: unknown[] };

function fakeDb(rows: Record<string, unknown>[] = []): { db: Pool; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  };
  return { db: db as unknown as Pool, calls };
}

function loaderFor(role: TenantContext['role'], tenantId = '15', userId = '42'): TenantContextLoader {
  return async () => ({
    userId,
    tenantId,
    tenantSlug: 'brendan-kam-2',
    role,
  }) as TenantContext;
}

const REJECTING_LOADER: TenantContextLoader = async () => {
  throw new TenantContextError('tenant_membership_missing', 'no session');
};

function patchReq(body: unknown): Request {
  return new Request('https://aries.example.com/api/marketing/auto-publish', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// 1. Kill switch
// ---------------------------------------------------------------------------

test('gate flag accepts exactly the canonical 4 truthy tokens', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
    assert.equal(
      isAutoPublishGateEnabled({ ARIES_AUTO_PUBLISH_GATE_ENABLED: v }),
      true,
      `expected ${JSON.stringify(v)} to enable the gate`,
    );
  }
  for (const v of ['0', 'false', 'no', 'off', '', 'enabled', '2']) {
    assert.equal(
      isAutoPublishGateEnabled({ ARIES_AUTO_PUBLISH_GATE_ENABLED: v }),
      false,
      `expected ${JSON.stringify(v)} to leave the gate off`,
    );
  }
  assert.equal(isAutoPublishGateEnabled({}), false, 'unset must default OFF');
});

test('worker twin parses the flag identically to the TS module', async () => {
  const { isAutoPublishGateEnabled: workerGateEnabled } = await loadWorker();
  // The worker is plain .mjs and cannot import the TS module, so the parser is
  // duplicated. This pins the two copies together — drift here means the app
  // and the dispatcher disagree about whether the gate is on.
  for (const v of ['1', 'true', 'yes', 'on', '0', 'false', 'off', '', 'nope']) {
    assert.equal(
      workerGateEnabled({ ARIES_AUTO_PUBLISH_GATE_ENABLED: v }),
      isAutoPublishGateEnabled({ ARIES_AUTO_PUBLISH_GATE_ENABLED: v }),
      `worker/TS disagreement on ${JSON.stringify(v)}`,
    );
  }
  assert.equal(workerGateEnabled({}), isAutoPublishGateEnabled({}));
});

// ---------------------------------------------------------------------------
// 2. Store
// ---------------------------------------------------------------------------

test('a tenant with no row reads back as disabled, never null', async () => {
  const { db } = fakeDb([]);
  const setting = await getAutoPublishSettingForTenant(db, 15);
  assert.deepEqual(setting, {
    tenantId: 15,
    enabled: false,
    updatedByUserId: null,
    updatedAt: null,
  });
});

test('reader binds tenant id as a parameter, never interpolated', async () => {
  const { db, calls } = fakeDb([]);
  await getAutoPublishSettingForTenant(db, 15);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [15]);
  assert.ok(!calls[0].sql.includes('15'), 'tenant id must not be interpolated into SQL');
});

test('writer upserts so the first flip is not a silent no-op', async () => {
  const { db, calls } = fakeDb([
    { tenant_id: 15, enabled: true, updated_by_user_id: 42, updated_at: '2026-08-12T00:00:00.000Z' },
  ]);
  const setting = await setAutoPublishEnabledForTenant(db, {
    tenantId: 15,
    enabled: true,
    updatedByUserId: 42,
  });
  assert.match(calls[0].sql, /INSERT INTO marketing_auto_publish_settings/);
  assert.match(calls[0].sql, /ON CONFLICT \(tenant_id\) DO UPDATE/);
  assert.deepEqual(calls[0].params, [15, true, 42]);
  assert.equal(setting.enabled, true);
});

test('a stored enabled=false row is as held as a missing one', async () => {
  const { db } = fakeDb([
    { tenant_id: 15, enabled: false, updated_by_user_id: 42, updated_at: null },
  ]);
  const setting = await getAutoPublishSettingForTenant(db, 15);
  assert.equal(setting.enabled, false);
});

// ---------------------------------------------------------------------------
// 3. Route
// ---------------------------------------------------------------------------

test('PATCH is refused for non-admin roles', async () => {
  for (const role of ['tenant_analyst', 'tenant_viewer'] as const) {
    const { db, calls } = fakeDb([]);
    const res = await handlePatchAutoPublish(patchReq({ enabled: true }), {
      tenantContextLoader: loaderFor(role),
      db,
    });
    assert.equal(res.status, 403, `${role} must not flip auto-publish`);
    assert.deepEqual(await res.json(), { error: 'forbidden' });
    assert.equal(calls.length, 0, 'a refused PATCH must not touch the database');
  }
});

test('PATCH by tenant_admin writes and echoes the new value', async () => {
  const { db, calls } = fakeDb([
    { tenant_id: 15, enabled: true, updated_by_user_id: 42, updated_at: '2026-08-12T00:00:00.000Z' },
  ]);
  const res = await handlePatchAutoPublish(patchReq({ enabled: true }), {
    tenantContextLoader: loaderFor('tenant_admin'),
    db,
    env: { ARIES_AUTO_PUBLISH_GATE_ENABLED: '1' },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { autoPublish: Record<string, unknown> };
  assert.equal(body.autoPublish.enabled, true);
  assert.equal(body.autoPublish.gateActive, true);
  assert.deepEqual(calls[0].params, [15, true, 42]);
});

test('PATCH requires an explicit boolean — {} is not "leave it alone"', async () => {
  for (const body of [{}, { enabled: null }, { enabled: 'maybe' }, { enabled: 2 }]) {
    const { db, calls } = fakeDb([]);
    const res = await handlePatchAutoPublish(patchReq(body), {
      tenantContextLoader: loaderFor('tenant_admin'),
      db,
    });
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be rejected`);
    assert.deepEqual(await res.json(), { error: 'invalid_enabled' });
    assert.equal(calls.length, 0);
  }
});

test('tenant id comes from context, never from the request body', async () => {
  const { db, calls } = fakeDb([
    { tenant_id: 15, enabled: false, updated_by_user_id: 42, updated_at: null },
  ]);
  const req = new Request('https://aries.example.com/api/marketing/auto-publish', {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false, tenantId: 70, tenant_id: 70 }),
    headers: { 'content-type': 'application/json' },
  });
  await handlePatchAutoPublish(req, { tenantContextLoader: loaderFor('tenant_admin', '15'), db });
  assert.equal(calls[0].params[0], 15, 'body-supplied tenant id must be ignored');
});

test('unauthenticated GET and PATCH are rejected', async () => {
  const { db } = fakeDb([]);
  for (const call of [
    () => handleGetAutoPublish(patchReq({}), { tenantContextLoader: REJECTING_LOADER, db }),
    () => handlePatchAutoPublish(patchReq({ enabled: true }), { tenantContextLoader: REJECTING_LOADER, db }),
  ]) {
    const res = await call();
    assert.ok(res.status === 401 || res.status === 403, `expected auth rejection, got ${res.status}`);
  }
});

test('GET reports gateActive so the UI cannot claim a dormant switch is live', async () => {
  const { db } = fakeDb([
    { tenant_id: 15, enabled: true, updated_by_user_id: 42, updated_at: null },
  ]);
  const off = await handleGetAutoPublish(patchReq({}), {
    tenantContextLoader: loaderFor('tenant_analyst'),
    db,
    env: {},
  });
  const body = (await off.json()) as { autoPublish: Record<string, unknown> };
  assert.equal(off.status, 200, 'GET is readable by every tenant role');
  assert.equal(body.autoPublish.enabled, true);
  assert.equal(body.autoPublish.gateActive, false, 'gate off => the toggle has no effect yet');
  assert.equal(body.autoPublish.canEdit, false, 'an analyst may read but not edit');
});

// ---------------------------------------------------------------------------
// 4. The admit predicate
// ---------------------------------------------------------------------------

test('the admit predicate qualifies its outer tenant_id', async () => {
  const { autoPublishAdmitSql } = await loadWorker();
  const sql = autoPublishAdmitSql('sp', '$3');
  // `s.tenant_id = tenant_id` would resolve the right-hand side to the
  // SUBQUERY's own column (inner scope wins), comparing s.tenant_id to itself:
  // always true, gate always open, no error raised. The qualification is the
  // entire defence.
  assert.match(sql, /s\.tenant_id = sp\.tenant_id/);
  assert.ok(!/=\s*tenant_id\b/.test(sql), 'outer tenant_id must be alias-qualified');
  assert.match(sql, /\$3 = false OR EXISTS/, 'kill switch must short-circuit before the EXISTS');
  assert.match(sql, /AND s\.enabled/, 'a row that exists but is disabled must not admit');
});

test('every dispatch-deciding statement carries the admit predicate', async () => {
  const { CLAIM_ROW_SQL, DUE_ROWS_SQL, SWEEP_DEAD_CAMPAIGN_SQL } = await loadWorker();
  const statements: Array<[string, string]> = [
    ['CLAIM_ROW_SQL', CLAIM_ROW_SQL],
    ['DUE_ROWS_SQL', DUE_ROWS_SQL],
    ['SWEEP_DEAD_CAMPAIGN_SQL', SWEEP_DEAD_CAMPAIGN_SQL],
  ];
  for (const [name, sql] of statements) {
    assert.match(
      sql,
      /marketing_auto_publish_settings/,
      `${name} must consult the auto-publish opt-in`,
    );
    assert.match(sql, /\$3 = false OR EXISTS/, `${name} must honour the kill switch`);
    assert.ok(
      !/=\s*tenant_id\b/.test(sql),
      `${name} has an unqualified outer tenant_id — the gate would always be open`,
    );
  }
});

test('the sweep guards every mutating arm, not just its read CTE', async () => {
  const { SWEEP_DEAD_CAMPAIGN_SQL } = await loadWorker();
  // The sweep marks rows failed and posts expired. If only the read arm were
  // gated, a held row could still be swept by the UPDATE and the week would
  // die exactly the way this gate exists to prevent.
  const occurrences = SWEEP_DEAD_CAMPAIGN_SQL.split('marketing_auto_publish_settings').length - 1;
  assert.equal(occurrences, 3, 'canonical, dead and marked must each re-check the predicate');
});
