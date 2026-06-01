import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioAccountProvider } from '@/backend/integrations/composio/composio-account-provider';
import { ComposioConfigError } from '@/backend/integrations/composio/errors';
import type { GatewayConnection } from '@/backend/integrations/composio/composio-client';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

const tenantId = '42';
const userId = 'aries-tenant-42';

function conn(id: string, toolkitSlug: string, status = 'ACTIVE'): GatewayConnection {
  return {
    id,
    status,
    statusReason: null,
    authConfigId: 'shared_default',
    toolkitSlug,
    externalAccountId: `ext_${id}`,
    externalAccountName: `${toolkitSlug} acct`,
    raw: {},
  };
}

test('createConnectLink without an auth config throws a clear config error', async () => {
  const provider = new ComposioAccountProvider(
    fakeGateway(),
    fakeConfig({ authConfigId: null }),
    fakeDb({ connectionRow: null }),
  );
  await assert.rejects(
    () => provider.createConnectLink(userId, 'facebook', 'full', { tenantId }),
    ComposioConfigError,
  );
});

test('createConnectLink returns the redirect URL and persists a pending row', async () => {
  // Default fakeDb returns a row for the upsert's RETURNING clause (Postgres
  // always returns the upserted row), matching real behavior.
  const db = fakeDb();
  const provider = new ComposioAccountProvider(fakeGateway(), fakeConfig(), db);
  const result = await provider.createConnectLink(userId, 'facebook', 'full', { tenantId });
  assert.equal(result.connectUrl, 'https://composio.dev/connect/abc');
  assert.ok(db.queries.some((q) => /insert into connected_accounts/i.test(q.text)));
});

test('refreshConnectionStatus picks the toolkit-matching connection under a shared default auth config', async () => {
  // Both an instagram and a facebook connection come back (shared default
  // auth config). Refreshing facebook must NOT store the instagram account id.
  const gateway = fakeGateway({ connections: [conn('ca_ig', 'instagram'), conn('ca_fb', 'facebook')] });
  const db = fakeDb();
  const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
  await provider.refreshConnectionStatus(userId, 'facebook', { tenantId });
  const upsert = db.queries.find((q) => /insert into connected_accounts/i.test(q.text));
  assert.ok(upsert, 'expected an upsert');
  // connected_account_id is param index 5 (1-based $5) -> array index 4.
  assert.equal(upsert!.params[4], 'ca_fb', 'must persist the facebook connected-account id, not instagram');
});
