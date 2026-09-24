import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  listOrganizationKinds,
  resolveFleetTenantKinds,
  setOrganizationKind,
  type TenantKindDb,
} from '@/backend/tenant/organization-kind';
import { assertPublishCanaryTenantKind } from '@/scripts/smoke-meta-publish';

const initDb = readFileSync(new URL('../scripts/init-db.js', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../migrations/20260819000000_organization_kind.sql', import.meta.url),
  'utf8',
);

test('organization kind defaults existing tenants to production and accepts only supported values', () => {
  for (const source of [initDb, migration]) {
    assert.match(source, /kind\s+TEXT\s+NOT NULL\s+DEFAULT\s+'production'/i);
    assert.match(source, /kind\s+IN\s*\(\s*'production'\s*,\s*'test'\s*,\s*'archived'\s*\)/i);
  }
});

test('admin controls list tenant kinds and persist a validated update', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: TenantKindDb = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) {
        return {
          rows: [
            { id: 1, name: 'Production', slug: 'production', kind: 'production' },
            { id: 2, name: 'Canary', slug: 'canary', kind: 'test' },
          ],
          rowCount: 2,
        };
      }
      return {
        rows: [{ id: 2, name: 'Canary', slug: 'canary', kind: 'test' }],
        rowCount: 1,
      };
    },
  };

  assert.deepEqual(
    (await listOrganizationKinds(db)).map(({ id, kind }) => ({ id, kind })),
    [
      { id: 1, kind: 'production' },
      { id: 2, kind: 'test' },
    ],
  );

  const updated = await setOrganizationKind(db, 2, 'test');
  assert.equal(updated?.kind, 'test');
  assert.deepEqual(calls[1]?.params, [2, 'test']);
  assert.match(calls[1]?.sql ?? '', /UPDATE organizations[\s\S]*WHERE id = \$1/i);

  await assert.rejects(() => setOrganizationKind(db, 2, 'customer' as never), /invalid organization kind/i);
  assert.equal(calls.length, 2, 'invalid values must not reach Postgres');
});

test('fleet tenant kinds default to production and require explicit valid inclusion', () => {
  assert.deepEqual(resolveFleetTenantKinds({}), ['production']);
  assert.deepEqual(
    resolveFleetTenantKinds({ ARIES_FLEET_TENANT_KINDS: ' production, test ' }),
    ['production', 'test'],
  );
  assert.throws(
    () => resolveFleetTenantKinds({ ARIES_FLEET_TENANT_KINDS: 'production,customer' }),
    /ARIES_FLEET_TENANT_KINDS/,
  );
});

test('the A4 publish canary only runs against a tenant classified as test', () => {
  assert.doesNotThrow(() => assertPublishCanaryTenantKind('test'));
  assert.throws(() => assertPublishCanaryTenantKind('production'), /kind=test/i);
  assert.throws(() => assertPublishCanaryTenantKind('archived'), /kind=test/i);
});
