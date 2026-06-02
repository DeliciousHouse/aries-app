import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { upsertConnection, deleteConnectionRow } from '@/backend/integrations/composio/connection-store';
import { fakeDb } from './composio/helpers';

const TOKEN_WORDS = ['access_token', 'refresh_token', 'access_token_enc', 'bearer'];

test('upsertConnection persists the connected_account_id, never a raw token', async () => {
  const db = fakeDb();
  await upsertConnection(
    {
      tenantId: '42',
      externalUserId: 'aries-tenant-42',
      platform: 'facebook',
      provider: 'composio',
      connectedAccountId: 'ca_abc',
      authConfigId: 'auth_cfg_test',
      status: 'connected',
    },
    db,
  );
  const insert = db.queries.find((q) => /insert into connected_accounts/i.test(q.text));
  assert.ok(insert, 'expected an INSERT into connected_accounts');
  const sql = insert!.text.toLowerCase();
  for (const word of TOKEN_WORDS) {
    assert.ok(!sql.includes(word), `INSERT SQL must not reference ${word}`);
  }
  // The connected-account id is among the params (the thing we DO store).
  assert.ok(insert!.params.includes('ca_abc'));
});

test('deleteConnectionRow targets tenant + platform and returns the connected_account_id', async () => {
  const db = fakeDb();
  const result = await deleteConnectionRow('42', 'facebook', db);
  const del = db.queries.find((q) => /delete from connected_accounts/i.test(q.text));
  assert.ok(del);
  assert.deepEqual(del!.params, ['42', 'facebook']);
  assert.equal(result.deleted, true);
});

test('connected_accounts DDL (init-db + migration) declares no token column', () => {
  const root = process.cwd();
  const initDb = readFileSync(join(root, 'scripts/init-db.js'), 'utf8');
  const migration = readFileSync(join(root, 'migrations/20260601000000_connected_accounts.sql'), 'utf8');

  for (const source of [initDb, migration]) {
    // Isolate the connected_accounts CREATE TABLE block.
    const idx = source.indexOf('connected_accounts');
    assert.ok(idx >= 0, 'connected_accounts table not found');
    const block = source.slice(idx, idx + 1200).toLowerCase();
    for (const word of TOKEN_WORDS) {
      assert.ok(!block.includes(word), `connected_accounts DDL must not declare a ${word} column`);
    }
    // It MUST store the connected-account id instead.
    assert.ok(block.includes('connected_account_id'));
  }
});
