import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComposioAccountProvider } from '@/backend/integrations/composio/composio-account-provider';
import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { listFacebookManagedPages } from '@/backend/integrations/composio/facebook-page-resolver';
import { handleComposioPages } from '@/app/api/integrations/composio/handlers';
import { fakeConfig, fakeDb, fakeGateway } from './composio/helpers';

const row = {
  id: 1, tenant_id: 42, external_user_id: 'aries-tenant-42', platform: 'facebook',
  provider: 'composio', connected_account_id: 'ca_current', auth_config_id: 'auth_cfg_test',
  external_account_id: null, external_account_name: null, status: 'connected',
  capabilities_json: null, last_capability_check_at: null, created_at: new Date(0), updated_at: new Date(0),
};
const pages = [{ id: 'page_other', name: 'Other business' }, { id: 'page_wines', name: 'Wines' }];
const live = {
  id: 'ca_current', status: 'ACTIVE', statusReason: null, authConfigId: 'auth_cfg_test',
  toolkitSlug: 'facebook', externalAccountId: 'metadata_is_not_a_page', externalAccountName: 'Profile', raw: {},
};

test('Facebook enumeration follows cursors, deduplicates and returns only picker-safe fields', async () => {
  const gateway = fakeGateway();
  gateway.executeTool = async (_slug, options) => options.arguments?.after
    ? { successful: true, error: null, data: { data: [pages[0], pages[1]] } }
    : { successful: true, error: null, data: { data: [{ ...pages[0], access_token: 'fixture-secret' }], paging: { next: 'not-fetched', cursors: { after: 'cursor2' } } } };
  assert.deepEqual(await listFacebookManagedPages(gateway, fakeConfig(), 'ca_current'), pages);
});

test('Meta reconciliation never chooses from metadata or managed pages, even a single page', async () => {
  for (const available of [pages, [pages[0]]]) {
    const gateway = fakeGateway({ connections: [live], executeResult: { successful: true, error: null, data: { data: available } } });
    const db = fakeDb({ connectionRow: row });
    await new ComposioAccountProvider(gateway, fakeConfig(), db).refreshConnectionStatus('aries-tenant-42', 'facebook', { tenantId: '42' });
    const write = db.queries.find(q => q.text.includes('INSERT INTO connected_accounts'))!;
    assert.equal(write.params[6], null);
    assert.equal(write.params[7], null);
    assert.equal(gateway.calls.length, 0);
  }
});

test('explicit page choice validates accessible ids and binds the tenant and connection on update', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { data: pages } } });
  const db = fakeDb({ connectionRow: row });
  const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
  await assert.rejects(provider.selectAccountPage('42', 'facebook', 'ca_current', 'page_ungranted'));
  assert.ok(!db.queries.some(q => q.text.includes('UPDATE connected_accounts')));
  await provider.selectAccountPage('42', 'facebook', 'ca_current', 'page_wines');
  const write = db.queries.find(q => q.text.includes('UPDATE connected_accounts'))!;
  assert.deepEqual(write.params, ['42', 'facebook', 'ca_current', 'page_wines', 'Wines']);
  assert.match(write.text, /connected_account_id = \$3/);
  assert.match(write.text, /status = 'connected'/);
  await assert.rejects(provider.selectAccountPage('42', 'facebook', 'ca_stale', 'page_wines'));
});

test('reconnect pins the initiated Meta connection and clears selection instead of retaining stale page', async () => {
  const db = fakeDb({ connectionRow: { ...row, external_account_id: 'page_old' } });
  const provider = new ComposioAccountProvider(fakeGateway(), fakeConfig(), db);
  await provider.createConnectLink('aries-tenant-42', 'facebook', 'full', { tenantId: '42' });
  const write = db.queries.find(q => q.text.includes('INSERT INTO connected_accounts'))!;
  assert.equal(write.params[4], 'cr_1');
  assert.match(write.text, /EXCLUDED\.status = 'pending'/);
  assert.match(write.text, /THEN EXCLUDED\.external_account_id/);
});

test('publishing refuses unconfirmed Meta identities without any provider call', async () => {
  for (const platform of ['facebook', 'instagram'] as const) {
    const gateway = fakeGateway();
    const publisher = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'PUBLISH' } }), fakeDb({ connectionRow: { ...row, platform } }));
    await assert.rejects(publisher.publishPost({ tenantId: '42', platform, content: 'hello', mediaUrls: [], approved: true }), /confirm/i);
    assert.equal(gateway.calls.length, 0);
  }
});

test('Facebook publishing uses the explicitly selected page, not the first visible page', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { id: 'post_1' } } });
  const publisher = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'PUBLISH' } }), fakeDb({ connectionRow: { ...row, external_account_id: 'page_wines' } }));
  await publisher.publishPost({ tenantId: '42', platform: 'facebook', content: 'hello', mediaUrls: [], approved: true });
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].options.arguments?.page_id, 'page_wines');
});

test('page enumeration fails closed on later errors or repeated/missing cursors', async () => {
  for (const failure of ['error', 'repeated', 'missing']) {
    let calls = 0;
    const gateway = fakeGateway();
    gateway.executeTool = async () => {
      calls++;
      if (failure === 'error' && calls > 1) throw new Error('unavailable');
      return { successful: true, error: null, data: { data: pages,
        paging: { next: 'never-fetch-this-url', cursors: failure === 'missing' ? {} : { after: 'same' } },
      } };
    };
    assert.equal(await listFacebookManagedPages(gateway, fakeConfig(), 'ca_current'), null);
    assert.ok(calls <= 2);
  }
});

test('Instagram lists and confirms only the identity exposed by its native OAuth connection', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { data: { id: '123456789', username: 'wines_ig' } } } });
  const db = fakeDb({ connectionRow: { ...row, platform: 'instagram' } });
  const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
  assert.deepEqual(await provider.listAccountPages('42', 'instagram'), { connectedAccountId: 'ca_current', pages: [{ id: '123456789', name: 'wines_ig' }] });
  assert.ok(!db.queries.some(q => q.text.includes('UPDATE connected_accounts')));
  await provider.selectAccountPage('42', 'instagram', 'ca_current', '123456789');
  assert.deepEqual(db.queries.find(q => q.text.includes('UPDATE connected_accounts'))?.params, ['42', 'instagram', 'ca_current', '123456789', 'wines_ig']);
});

test('pending OAuth reconciliation cannot revive an old active Facebook grant', async () => {
  const db = fakeDb({ connectionRow: { ...row, status: 'pending', connected_account_id: 'ca_new' } });
  const provider = new ComposioAccountProvider(fakeGateway({ connections: [live] }), fakeConfig(), db);
  const result = await provider.refreshConnectionStatus('aries-tenant-42', 'facebook', { tenantId: '42' });
  assert.ok(result);
  assert.equal(result.status, 'pending');
  assert.equal(result.connectedAccountId, 'ca_new');
  assert.ok(!db.queries.some(q => q.text.includes('INSERT INTO connected_accounts')));
});

test('page API is tenant-authenticated and ignores client-supplied tenant ids', async () => {
  const db = fakeDb({ connectionRow: row });
  const provider = new ComposioAccountProvider(fakeGateway({ executeResult: { successful: true, error: null, data: { data: pages } } }), fakeConfig(), db);
  const loader = async () => ({ userId: 'u42', tenantId: '42', tenantSlug: 'wines', role: 'tenant_admin' as const });
  const request = (body: unknown) => new Request('https://aries.example/api/pages', { method: 'POST', body: JSON.stringify(body) });
  const denied = await handleComposioPages(request({ pageId: 'page_wines', connectedAccountId: 'ca_current' }), 'facebook', async () => { throw new Error('Authentication required'); }, provider);
  assert.equal(denied.status, 403);
  assert.equal(db.queries.length, 0);
  assert.equal((await handleComposioPages(request(null), 'facebook', loader, provider)).status, 400);
  assert.equal((await handleComposioPages(request({}), 'youtube', loader, provider)).status, 400);
  const response = await handleComposioPages(request({ tenantId: '999', pageId: 'page_wines', connectedAccountId: 'ca_current' }), 'facebook', loader, provider);
  assert.equal(response.status, 200);
  assert.equal(db.queries.find(q => q.text.includes('UPDATE connected_accounts'))?.params[0], '42');
});
