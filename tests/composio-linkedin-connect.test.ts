import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComposioAccountProvider } from '@/backend/integrations/composio/composio-account-provider';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

const row = { id: 1, tenant_id: 42, external_user_id: 'aries-tenant-42', platform: 'linkedin', provider: 'composio',
  connected_account_id: 'ca_li', auth_config_id: 'auth_cfg_test', external_account_id: null,
  external_account_name: null, status: 'connected', capabilities_json: null, last_capability_check_at: null,
  created_at: new Date(0), updated_at: new Date(0) };

for (const data of [
  { id: 'member', localizedFirstName: 'Jane', localizedLastName: 'Doe' },
  { results: [{ response: { successful: true, data: { id: 'member', name: 'Jane Doe' } } }] },
]) {
  test('LinkedIn picker resolves the full person URN without persisting it before Confirm', async () => {
    const db = fakeDb({ connectionRow: row });
    const gateway = fakeGateway({ executeResult: { successful: true, error: null, data } });
    const choices = await new ComposioAccountProvider(gateway, fakeConfig(), db)
      .listAccountPages('aries-tenant-42', 'linkedin', { tenantId: '42' });
    assert.deepEqual(choices.pages, [{ id: 'urn:li:person:member', name: 'Jane Doe', hasInstagram: false }]);
    assert.equal(gateway.calls[0].slug, 'LINKEDIN_GET_MY_INFO');
    assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_li');
    assert.equal(db.queries.filter(q => /UPDATE|INSERT/.test(q.text)).length, 0);
  });
}

for (const result of [
  { successful: false, error: 'scope_missing', data: null },
  { successful: true, error: null, data: { id: 'member' } },
  { successful: true, error: null, data: {} },
]) {
  test('LinkedIn picker fails closed when identity or display name cannot be verified', async () => {
    const db = fakeDb({ connectionRow: row });
    const provider = new ComposioAccountProvider(fakeGateway({ executeResult: result }), fakeConfig(), db);
    await assert.rejects(provider.listAccountPages('aries-tenant-42', 'linkedin', { tenantId: '42' }), /account choices/i);
    assert.equal(db.queries.filter(q => /UPDATE|INSERT/.test(q.text)).length, 0);
  });
}
