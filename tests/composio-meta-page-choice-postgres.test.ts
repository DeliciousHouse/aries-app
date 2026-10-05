import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { ComposioAccountProvider } from '@/backend/integrations/composio/composio-account-provider';
import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { getConnectionRow, upsertConnection } from '@/backend/integrations/composio/connection-store';
import { fakeConfig, fakeGateway } from './composio/helpers';
import { requireDbEnvOrSkip } from './helpers/requires-infra';

test('PostgreSQL: confirm, change page, reconnect and stale reconciliation preserve tenant-safe choices', async t => {
  if (!requireDbEnvOrSkip(t)) return;
  const client = new pg.Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Session-local tables execute the real store SQL without touching app data.
    await client.query('CREATE TEMP TABLE organizations (id INTEGER PRIMARY KEY)');
    await client.query('INSERT INTO organizations VALUES (42), (43)');
    const ddl = fs.readFileSync('migrations/20260601000000_connected_accounts.sql', 'utf8')
      .match(/CREATE TABLE IF NOT EXISTS connected_accounts \([\s\S]*?\n\);/)?.[0];
    assert.ok(ddl);
    await client.query(ddl.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    let connectionId = 'ca_first';
    const gateway = fakeGateway();
    gateway.initiateConnection = async () => ({ connectionRequestId: connectionId, redirectUrl: 'https://example.com/oauth' });
    gateway.listConnections = async () => [{
      id: connectionId, status: 'ACTIVE', statusReason: null, authConfigId: 'auth_cfg_test',
      toolkitSlug: 'facebook', externalAccountId: null, externalAccountName: null, raw: {},
    }];
    gateway.executeTool = async (slug, options) => {
      gateway.calls.push({ slug, options });
      return slug === 'PUBLISH'
        ? { successful: true, error: null, data: { id: 'post_1' } }
        : { successful: true, error: null, data: { data: [{ id: 'page_first', name: 'First' }, { id: 'page_chosen', name: 'Chosen' }] } };
    };
    const config = fakeConfig({ actions: { publish_post: 'PUBLISH' } });
    const provider = new ComposioAccountProvider(gateway, config, client);
    const publisher = new ComposioPublisherProvider(gateway, config, client);
    const input = { tenantId: '42', platform: 'facebook' as const, content: 'test', mediaUrls: [], approved: true };
    const connectOptions = { tenantId: '42', callbackUrl: 'https://aries.example.com/onboarding/connect' };
    await provider.createConnectLink('aries-tenant-42', 'facebook', 'full', connectOptions);
    await provider.refreshConnectionStatus('aries-tenant-42', 'facebook', { tenantId: '42' });
    await assert.rejects(publisher.publishPost(input), /confirm/);
    await provider.selectAccountPage('42', 'facebook', connectionId, 'page_chosen');
    await publisher.publishPost(input);
    assert.equal(gateway.calls.find(c => c.slug === 'PUBLISH')?.options.arguments?.page_id, 'page_chosen');
    assert.equal((await getConnectionRow('42', 'facebook', client))?.externalAccountName, 'Chosen');
    await provider.selectAccountPage('42', 'facebook', connectionId, 'page_first');
    await provider.refreshConnectionStatus('aries-tenant-42', 'facebook', { tenantId: '42' });
    assert.equal((await getConnectionRow('42', 'facebook', client))?.externalAccountId, 'page_first', 'reconcile retains explicit change');
    await assert.rejects(provider.selectAccountPage('43', 'facebook', connectionId, 'page_chosen'));

    // Reused AND replaced Composio ids must clear the old page at OAuth start.
    for (const id of ['ca_first', 'ca_reconnected']) {
      connectionId = id;
      await provider.createConnectLink('aries-tenant-42', 'facebook', 'full', connectOptions);
      assert.equal((await getConnectionRow('42', 'facebook', client))?.externalAccountId, null);
      await provider.refreshConnectionStatus('aries-tenant-42', 'facebook', { tenantId: '42' });
      await assert.rejects(publisher.publishPost(input), /confirm/);
      await provider.selectAccountPage('42', 'facebook', connectionId, 'page_chosen');
      assert.equal((await getConnectionRow('42', 'facebook', client))?.externalAccountId, 'page_chosen');
    }

    // A refresh started against an earlier connection cannot overwrite OAuth.
    connectionId = 'ca_new_attempt';
    await provider.createConnectLink('aries-tenant-42', 'facebook', 'full', connectOptions);
    const stale = await upsertConnection({
      tenantId: '42', externalUserId: 'aries-tenant-42', platform: 'facebook', provider: 'composio',
      connectedAccountId: 'ca_reconnected', status: 'connected',
      expectedConnection: { connectedAccountId: 'ca_reconnected', status: 'connected' },
    }, client);
    assert.equal(stale.status, 'pending');
    assert.equal(stale.connectedAccountId, 'ca_new_attempt');
    assert.equal(stale.externalAccountId, null);

    // Instagram uses the same persistence rule, including reused native grants.
    await upsertConnection({ tenantId: '42', externalUserId: 'aries-tenant-42', platform: 'instagram',
      provider: 'composio', connectedAccountId: 'ca_ig', status: 'connected', externalAccountId: '123', externalAccountName: 'Old IG' }, client);
    await upsertConnection({ tenantId: '42', externalUserId: 'aries-tenant-42', platform: 'instagram',
      provider: 'composio', connectedAccountId: 'ca_ig', status: 'pending' }, client);
    assert.equal((await getConnectionRow('42', 'instagram', client))?.externalAccountId, null);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
