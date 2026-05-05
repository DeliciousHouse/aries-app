import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIntegrationsGet } from '../app/api/integrations/handlers';
import { handlePlatformConnectionsGet } from '../app/api/platform-connections/handlers';
import { oauthStore } from '../backend/integrations/connect';

async function withProviderEnv(run: () => Promise<void>): Promise<void> {
  const previous = {
    META_PAGE_ID: process.env.META_PAGE_ID,
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    OPENAI_CLIENT_ID: process.env.OPENAI_CLIENT_ID,
    OPENAI_CLIENT_SECRET: process.env.OPENAI_CLIENT_SECRET,
    OAUTH_TOKEN_ENCRYPTION_KEY: process.env.OAUTH_TOKEN_ENCRYPTION_KEY,
  };
  process.env.META_PAGE_ID = 'meta-page-test';
  process.env.META_ACCESS_TOKEN = 'meta-token-test';
  process.env.OPENAI_CLIENT_ID = 'openai-client-test';
  process.env.OPENAI_CLIENT_SECRET = 'openai-secret-test';
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 'a').toString('base64');
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('/api/integrations does not expose OpenAI through generic integration cards', async () => {
  const response = await handleIntegrationsGet(async () => ({
    userId: 'user_openai_safety',
    tenantId: 'tenant_openai_safety',
    tenantSlug: 'tenant-openai-safety',
    role: 'tenant_admin',
  }));
  const body = (await response.json()) as {
    supported_platforms: string[];
    cards: Array<Record<string, unknown>>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.supported_platforms.includes('openai'), false);
  assert.equal(body.cards.some((card) => card.platform === 'openai'), false);

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('ChatGPT / OpenAI'), false);
  assert.equal(serialized.includes('"openai"'), false);
});

test('/api/platform-connections keeps OpenAI status browser-safe without dropping generic platforms', async () => {
  await withProviderEnv(async () => {
    const store = oauthStore();
    store.pendingByState.clear();
    store.connectionsById.clear();
    store.connectedByTenantProvider.clear();
    const expiry = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    store.connectionsById.set('conn_openai_safe', {
      connection_id: 'conn_openai_safe',
      provider: 'openai',
      tenant_id: 'tenant_openai_safety',
      connection_status: 'connected',
      granted_scopes: [],
      created_at: '2026-05-05T00:00:00.000Z',
      updated_at: '2026-05-05T00:00:00.000Z',
      token_expires_at: expiry,
    });
    store.connectedByTenantProvider.set('tenant_openai_safety::openai', 'conn_openai_safe');
    store.connectionsById.set('conn_facebook_safe', {
      connection_id: 'conn_facebook_safe',
      provider: 'facebook',
      tenant_id: 'tenant_openai_safety',
      connection_status: 'connected',
      granted_scopes: [],
      created_at: '2026-05-05T00:00:00.000Z',
      updated_at: '2026-05-05T00:00:00.000Z',
      token_expires_at: expiry,
    });
    store.connectedByTenantProvider.set('tenant_openai_safety::facebook', 'conn_facebook_safe');

    const response = await handlePlatformConnectionsGet(async () => ({
      userId: 'user_openai_safety',
      tenantId: 'tenant_openai_safety',
      tenantSlug: 'tenant-openai-safety',
      role: 'tenant_admin',
    }));
    const body = (await response.json()) as {
      connections: Array<Record<string, unknown>>;
    };

    const openai = body.connections.find((connection) => connection.provider === 'openai');
    assert.deepEqual(Object.keys(openai ?? {}).sort(), [
      'connected',
      'label',
      'lastCheckedAt',
      'provider',
      'tokenHealth',
    ]);
    assert.equal(openai?.connected, true);
    assert.equal(openai?.tokenHealth, 'valid');
    assert.equal(JSON.stringify(openai).includes('conn_openai_safe'), false);

    const facebook = body.connections.find((connection) => connection.provider === 'facebook');
    assert.equal(facebook?.provider, 'facebook');
    assert.equal(facebook?.tenant_id, 'tenant_openai_safety');
    assert.equal(typeof facebook?.token_health, 'string');
    assert.equal(typeof facebook?.connection_status, 'string');
  });
});
