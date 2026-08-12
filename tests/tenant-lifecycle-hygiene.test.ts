import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildTenantDispositionDigest,
  setOrganizationKind,
  type TenantHygieneRow,
} from '@/backend/tenant/lifecycle-hygiene';
import { SELECT_ALERT_CANDIDATES_SQL } from '@/backend/billing/quota-alerts';
import { assertPublishCanaryTenantKind } from '@/scripts/smoke-meta-publish';

const initDb = readFileSync(new URL('../scripts/init-db.js', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../migrations/20260812000000_tenant_lifecycle_hygiene.sql', import.meta.url),
  'utf8',
);

function row(overrides: Partial<TenantHygieneRow>): TenantHygieneRow {
  return {
    id: 1,
    name: 'Sugar & Leather',
    slug: 'sugar-leather',
    kind: 'production',
    activeMembers: 1,
    connectionCount: 1,
    publishedPostCount: 2,
    lastActivityAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

test('organization kind is constrained and defaults legacy tenants to production', () => {
  for (const source of [initDb, migration]) {
    assert.match(source, /organizations[\s\S]*kind\s+TEXT\s+NOT NULL\s+DEFAULT\s+'production'/i);
    assert.match(source, /kind\s+IN\s*\(\s*'production'\s*,\s*'test'\s*,\s*'archived'\s*\)/i);
  }
});

test('fleet alert candidates exclude test and archived organizations by default', () => {
  assert.match(SELECT_ALERT_CANDIDATES_SQL, /JOIN organizations o ON o\.id = s\.company_id/i);
  assert.match(SELECT_ALERT_CANDIDATES_SQL, /WHERE o\.kind = 'production'/i);
});

test('admin kind updates validate the value and only update the selected organization', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [{ id: 12, name: 'Canary', slug: 'canary', kind: 'test' }], rowCount: 1 };
    },
  };

  const updated = await setOrganizationKind(db, 12, 'test');
  assert.equal(updated?.kind, 'test');
  assert.deepEqual(calls[0]?.params, [12, 'test']);
  assert.match(calls[0]?.sql ?? '', /UPDATE organizations[\s\S]*WHERE id = \$1/i);

  await assert.rejects(() => setOrganizationKind(db, 12, 'customer' as never), /invalid organization kind/i);
  assert.equal(calls.length, 1, 'invalid input must not reach Postgres');
});

test('the publish canary refuses production and archived tenants', () => {
  assert.doesNotThrow(() => assertPublishCanaryTenantKind('test'));
  assert.throws(() => assertPublishCanaryTenantKind('production'), /kind=test/i);
  assert.throws(() => assertPublishCanaryTenantKind('archived'), /kind=test/i);
});

test('duplicate-organization digest is deterministic, proposes only, and never mutates data', () => {
  const digest = buildTenantDispositionDigest([
    row({ id: 5, name: 'Sugar and Leather', activeMembers: 3, publishedPostCount: 20 }),
    row({ id: 9, name: 'Sugar & Leather', activeMembers: 0, connectionCount: 0, publishedPostCount: 0 }),
    row({ id: 20, name: 'Aries AI', slug: 'aries-ai', activeMembers: 2 }),
    row({ id: 21, name: 'Aries-AI', slug: 'aries-ai-test', kind: 'test', activeMembers: 0 }),
  ]);

  assert.equal(digest.title, 'Tenant lifecycle hygiene proposal');
  assert.equal(digest.requiresOwnerApproval, true);
  assert.deepEqual(
    digest.candidates.map((candidate) => ({ keep: candidate.keepTenantId, review: candidate.reviewTenantIds })),
    [
      { keep: 20, review: [21] },
      { keep: 5, review: [9] },
    ],
  );
  assert.match(digest.candidates[0]?.proposal ?? '', /archive/i);
  assert.doesNotMatch(JSON.stringify(digest), /delete/i);
});
