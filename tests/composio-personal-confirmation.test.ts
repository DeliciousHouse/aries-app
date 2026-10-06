import assert from 'node:assert/strict';
import test from 'node:test';
import { ComposioAccountProvider } from '@/backend/integrations/composio/composio-account-provider';
import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { getConnectionRow } from '@/backend/integrations/composio/connection-store';
import { platformPrerequisites } from '@/backend/integrations/composio/capability-preflight';
import { fakeConfig, fakeDb, fakeGateway } from './composio/helpers';

for (const platform of ['linkedin', 'x'] as const) {
  const row = { id: 1, tenant_id: 42, external_user_id: 'aries-tenant-42', platform, provider: 'composio',
    connected_account_id: 'ca_current', auth_config_id: 'auth_cfg_test', external_account_id: null,
    external_account_name: null, status: 'connected', capabilities_json: null, last_capability_check_at: null,
    created_at: new Date(0), updated_at: new Date(0) };
  const identity = platform === 'linkedin' ? 'urn:li:person:member' : 'shop_owner';
  const profile = platform === 'linkedin' ? { id: 'member', localizedFirstName: 'Shop', localizedLastName: 'Owner' }
    : { username: 'shop_owner', name: 'Shop Owner' };

  test(`${platform} OAuth stays unconfirmed; discovery is read-only and Confirm persists the verified identity`, async () => {
    const db = fakeDb({ connectionRow: row });
    const gateway = fakeGateway({ connections: [{ id: 'ca_current', toolkitSlug: platform, status: 'ACTIVE',
      statusReason: null, authConfigId: 'auth_cfg_test', externalAccountId: 'metadata', externalAccountName: 'Metadata', raw: {} }],
      executeResult: { successful: true, error: null, data: profile } });
    const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
    assert.equal((await provider.refreshConnectionStatus('aries-tenant-42', platform, { tenantId: '42' }))?.status, 'unconfirmed');
    assert.equal(gateway.calls.length, 0);
    assert.equal(db.queries.filter(q => /UPDATE|INSERT/.test(q.text)).some(q => q.params.includes('metadata')), false);
    assert.deepEqual((await provider.listAccountPages('aries-tenant-42', platform, { tenantId: '42' })).pages,
      [{ id: identity, name: platform === 'x' ? 'Shop Owner (@shop_owner)' : 'Shop Owner', hasInstagram: false }]);
    await assert.rejects(provider.selectAccountPage('aries-tenant-42', platform, 'ca_stale', identity, { tenantId: '42' }));
    await assert.rejects(provider.selectAccountPage('aries-tenant-42', platform, 'ca_current', 'forged', { tenantId: '42' }));
    await assert.rejects(provider.listAccountPages('aries-tenant-99', platform, { tenantId: '99' }));
    await provider.selectAccountPage('aries-tenant-42', platform, 'ca_current', identity, { tenantId: '42' });
    const write = db.queries.find(q => /SET external_account_id/.test(q.text))!;
    assert.deepEqual(write.params.slice(0, 4), ['42', platform, 'ca_current', identity]);
    assert.match(write.text, /external_user_id = \$6 AND status = 'connected'/);
    Object.assign(row, { external_account_id: identity, external_account_name: 'Shop Owner' });
    assert.equal((await getConnectionRow('42', platform, db))?.status, 'connected');
    await provider.refreshConnectionStatus('aries-tenant-42', platform, { tenantId: '42' });
    assert.equal((await getConnectionRow('42', platform, db))?.externalAccountId, identity);
    Object.assign(row, { external_account_id: null, external_account_name: null });
  });

  test(`${platform} unconfirmed publishing fails before any provider call`, async () => {
    const gateway = fakeGateway();
    const publisher = new ComposioPublisherProvider(gateway, fakeConfig({ actions: { publish_post: 'PUBLISH' } }), fakeDb({ connectionRow: row }));
    await assert.rejects(publisher.publishPost({ tenantId: '42', platform, content: 'Synthetic', mediaUrls: [], approved: true }), /confirm/i);
    assert.equal(gateway.calls.length, 0);
  });

  test(`${platform} reconnect pins a new grant and clears prior confirmation`, async () => {
    const db = fakeDb({ connectionRow: { ...row, status: 'pending', connected_account_id: 'cr_1', external_account_id: identity } });
    const gateway = fakeGateway({ connections: [{ id: 'ca_old', toolkitSlug: platform, status: 'ACTIVE', statusReason: null,
      authConfigId: 'auth_cfg_test', externalAccountId: identity, externalAccountName: 'Old', raw: {} }] });
    const provider = new ComposioAccountProvider(gateway, fakeConfig(), db);
    await provider.createConnectLink('aries-tenant-42', platform, 'publish', { tenantId: '42' });
    const insert = db.queries.find(q => /INSERT/.test(q.text))!;
    assert.equal(insert.params[4], 'cr_1');
    assert.ok(insert.text.includes("'linkedin', 'x'"));
    db.queries.length = 0;
    await provider.refreshConnectionStatus('aries-tenant-42', platform, { tenantId: '42' });
    assert.equal(db.queries.filter(q => /UPDATE|INSERT/.test(q.text)).length, 0);
  });
}

test('LinkedIn prerequisites accurately restrict posting to personal profiles', () => {
  assert.match(platformPrerequisites('linkedin').join(' '), /personal profiles only/i);
  assert.doesNotMatch(platformPrerequisites('linkedin').join(' '), /connect an Organization Page/i);
});
