import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposioAccountProvider } from '@/backend/integrations/composio/composio-account-provider';
import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { fakeConfig, fakeDb, fakeGateway } from './composio/helpers';
import { listMetaAccountChoices } from '@/backend/integrations/composio/meta-account-choices';

const pages = [{ id: 'p1', name: 'North shop' }, { id: 'p2', name: 'South shop' }];
const row = {
  id: 1, tenant_id: 42, external_user_id: 'aries-tenant-42', platform: 'facebook', provider: 'composio',
  connected_account_id: 'ca_123', auth_config_id: 'auth_cfg_test', external_account_id: null,
  external_account_name: null, status: 'connected', capabilities_json: null,
  last_capability_check_at: null, created_at: new Date(0), updated_at: new Date(0),
};

test('reconcile leaves Meta identity unconfirmed rather than selecting metadata or first page', async () => {
  const gateway = fakeGateway({ connections: [{ id: 'ca_123', toolkitSlug: 'facebook', status: 'ACTIVE',
    statusReason: null, authConfigId: 'auth_cfg_test', externalAccountId: 'user_not_page', externalAccountName: 'Profile', raw: {} }] });
  const db = fakeDb({ connectionRow: row });
  await new ComposioAccountProvider(gateway, fakeConfig(), db).refreshConnectionStatus('aries-tenant-42', 'facebook', { tenantId: '42' });
  const write = db.queries.find(q => /UPDATE connected_accounts/.test(q.text))!;
  assert.deepEqual(write.params, ['42', 'facebook', 'ca_123', 'connected', 'aries-tenant-42']);
  assert.doesNotMatch(write.text, /SET external_account_id|external_account_name/);
  assert.equal(gateway.calls.length, 0);
});

test('unconfirmed Facebook and Instagram cannot publish, even if discovery could succeed', async () => {
  for (const platform of ['facebook', 'instagram'] as const) {
    const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { data: pages } } });
    const provider = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'PUBLISH' } }), fakeDb({ connectionRow: { ...row, platform } }));
    await assert.rejects(provider.publishPost({ tenantId: '42', platform, content: 'text', mediaUrls: ['https://example.com/synthetic.jpg'], approved: true }), /confirm/i);
    assert.equal(gateway.calls.length, 0);
  }
});

test('enumeration returns all cursor pages, safe fields only, and rejects incomplete discovery', async () => {
  const gateway = fakeGateway();
  gateway.executeTool = async (_slug, options) => options.arguments?.after
    ? { successful: true, error: null, data: { data: [pages[1]] } }
    : { successful: true, error: null, data: { data: [{ ...pages[0], access_token: 'synthetic' }], paging: { next: 'not-followed', cursors: { after: 'c2' } } } };
  assert.deepEqual(await listMetaAccountChoices(gateway, fakeConfig(), 'ca_123', 'facebook'),
    pages.map(p => ({ ...p, hasInstagram: false })));
  gateway.executeTool = async () => ({ successful: true, error: null, data: { data: [null] } });
  await assert.rejects(listMetaAccountChoices(gateway, fakeConfig(), 'ca_123', 'facebook'));
  gateway.executeTool = async () => ({ successful: true, error: null, data: { data: pages, paging: { next: 'incomplete' } } });
  await assert.rejects(listMetaAccountChoices(gateway, fakeConfig(), 'ca_123', 'facebook'));
});

test('selection validates grant membership and fences the tenant, user, and current connection', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { data: pages } } });
  const db = fakeDb({ connectionRow: row });
  const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
  await assert.rejects(provider.selectAccountPage('aries-tenant-42', 'facebook', 'ca_123', 'ungranted', { tenantId: '42' }));
  await provider.selectAccountPage('aries-tenant-42', 'facebook', 'ca_123', 'p2', { tenantId: '42' });
  const write = db.queries.find(q => /UPDATE connected_accounts/.test(q.text))!;
  assert.deepEqual(write.params, ['42', 'facebook', 'ca_123', 'p2', 'South shop', 'aries-tenant-42']);
  assert.match(write.text, /connected_account_id = \$3/);
  await assert.rejects(provider.selectAccountPage('aries-tenant-42', 'facebook', 'stale', 'p2', { tenantId: '42' }));
  await assert.rejects(provider.listAccountPages('aries-tenant-99', 'facebook', { tenantId: '99' }));
});

test('reconnect pins the new OAuth grant, clears selection, and cannot reactivate an older grant', async () => {
  const gateway = fakeGateway({ connections: [{ id: 'ca_old', toolkitSlug: 'facebook', status: 'ACTIVE',
    statusReason: null, authConfigId: 'auth_cfg_test', externalAccountId: 'p1', externalAccountName: 'Old Page', raw: {} }] });
  const db = fakeDb({ connectionRow: { ...row, connected_account_id: 'cr_1', status: 'pending' } });
  gateway.initiateConnection = async (_user, _auth, _callback, allowMultiple) => {
    assert.equal(allowMultiple, true, 'Meta reconnect must not fail the SDK existing-grant preflight');
    return { connectionRequestId: 'cr_1', redirectUrl: 'https://example.com/connect' };
  };
  const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
  await provider.createConnectLink('aries-tenant-42', 'facebook', 'publish', { tenantId: '42' });
  const insert = db.queries.find(q => /INSERT INTO connected_accounts/.test(q.text))!;
  assert.equal(insert.params[4], 'cr_1');
  assert.deepEqual(insert.params.slice(6, 9), [null, null, 'pending']);
  assert.match(insert.text, /EXCLUDED.status = 'pending'/);
  assert.match(insert.text, /IS DISTINCT FROM connected_accounts.connected_account_id/);
  db.queries.length = 0;
  await provider.refreshConnectionStatus('aries-tenant-42', 'facebook', { tenantId: '42' });
  assert.equal(db.queries.filter(q => /UPDATE|INSERT/.test(q.text)).length, 0);
  await assert.rejects(provider.listAccountPages('aries-tenant-42', 'facebook', { tenantId: '42' }), /Reconnect/);
});

test('selection rejects a reconnect during discovery; Instagram confirms only the authenticated account', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { data: { id: 'ig1', username: 'north_shop' } } } });
  const db = fakeDb({ connectionRow: { ...row, platform: 'instagram' } });
  const original = db.query.bind(db);
  db.query = async (sql, params) => /UPDATE/.test(sql) ? { rows: [], rowCount: 0 } : original(sql, params);
  const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
  assert.deepEqual((await provider.listAccountPages('aries-tenant-42', 'instagram', { tenantId: '42' })).pages,
    [{ id: 'ig1', name: 'north_shop', hasInstagram: true }]);
  await assert.rejects(provider.selectAccountPage('aries-tenant-42', 'instagram', 'ca_123', 'ig1', { tenantId: '42' }), /Connection changed/);
});

test('publishing after confirmation passes exactly the chosen Facebook page_id', async () => {
  const selectedRow = { ...row };
  const db = fakeDb({ connectionRow: selectedRow });
  const original = db.query.bind(db);
  db.query = async (sql, params) => {
    if (/SET external_account_id/.test(sql)) {
      Object.assign(selectedRow, { external_account_id: params![3], external_account_name: params![4] });
    }
    return original(sql, params);
  };
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { data: pages } } });
  await new ComposioAccountProvider(gateway, fakeConfig(), db).selectAccountPage('aries-tenant-42', 'facebook', 'ca_123', 'p2', { tenantId: '42' });
  gateway.executeTool = async (slug, options) => {
    assert.equal(slug, 'PUBLISH');
    assert.equal(options.connectedAccountId, 'ca_123');
    assert.equal(options.arguments?.page_id, 'p2');
    return { successful: true, error: null, data: { id: 'synthetic_post' } };
  };
  const result = await new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'PUBLISH' } }), db)
    .publishPost({ tenantId: '42', platform: 'facebook', content: 'Synthetic', mediaUrls: [], approved: true });
  assert.equal(result.externalPostId, 'synthetic_post');
});
