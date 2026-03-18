import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIntegrationsConnect, handleIntegrationsDisconnect, handleOauthReconnect } from '../../app/api/integrations/handlers';
import { handleOauthCallbackHttp } from '../../backend/integrations/callback';
import { oauthStore } from '../../backend/integrations/connect';
import { buildOauthConnectInput } from '../../lib/oauth-connect-input';
import { verifyLogin } from '../../frontend/services/supabase';

function resetOauthStore(): void {
  const store = oauthStore();
  store.pendingByState.clear();
  store.connectionsById.clear();
  store.connectedByTenantProvider.clear();
}

function seedConnectedProvider(input: {
  tenantId: string;
  provider: 'facebook' | 'instagram';
  connectionId: string;
  updatedAt: string;
  grantedScopes?: string[];
}) {
  const store = oauthStore();
  store.connectionsById.set(input.connectionId, {
    connection_id: input.connectionId,
    provider: input.provider,
    tenant_id: input.tenantId,
    connection_status: 'connected',
    granted_scopes: input.grantedScopes ?? [],
    created_at: input.updatedAt,
    updated_at: input.updatedAt,
  });
  store.connectedByTenantProvider.set(`${input.tenantId}::${input.provider}`, input.connectionId);
}

test('placeholder login helper rejects authentication attempts', async () => {
  await assert.rejects(
    () => verifyLogin('user@example.com', 'Password1!'),
    /google oauth|temporarily unavailable/i
  );
});

test('integrations connect input uses authenticated tenant context instead of request body tenant_id', async () => {
  const request = new Request('https://aries.example.com/api/integrations/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'facebook', tenant_id: 'forged-tenant' }),
  });

  const input = await buildOauthConnectInput(request, {
    userId: 'user_123',
    tenantId: 'tenant_real',
    tenantSlug: 'acme',
    role: 'tenant_admin',
  });

  assert.equal(input.provider, 'facebook');
  assert.equal(input.payload.tenant_id, 'tenant_real');
});

test('integrations connect builds callback URLs from APP_BASE_URL using auth namespace', async () => {
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://app.example.com';

  try {
    const request = new Request('https://ignored.example.com/api/integrations/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'facebook', tenant_id: 'forged-tenant' }),
    });

    const input = await buildOauthConnectInput(request, {
      userId: 'user_123',
      tenantId: 'tenant_real',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    });
    assert.equal(input.payload.tenant_id, 'tenant_real');
    assert.equal(input.payload.redirect_uri, 'https://app.example.com/api/auth/oauth/facebook/callback');
  } finally {
    if (previousAppBaseUrl === undefined) {
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = previousAppBaseUrl;
    }
  }
});

test('oauth connect routes ignore forged tenant_id and use authenticated tenant context', async () => {
  const request = new Request('https://aries.example.com/api/auth/oauth/facebook/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'forged-tenant',
      redirect_uri: 'https://forged.example.com/callback',
      scopes: ['pages_manage_posts'],
    }),
  });

  const response = await handleIntegrationsConnect(
    request,
    'facebook',
    async () => ({
      userId: 'user_123',
      tenantId: 'tenant_real',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    })
  );
  const body = (await response.json()) as {
    broker_status: string;
    provider: string;
    authorization_url: string;
    state: string;
  };

  assert.equal(response.status, 200);
  assert.equal(body.broker_status, 'ok');
  assert.equal(body.provider, 'facebook');
  assert.match(body.authorization_url, /state=/);
  assert.match(body.authorization_url, /redirect_uri=https%3A%2F%2Faries\.example\.com%2Fapi%2Fauth%2Foauth%2Ffacebook%2Fcallback/);
});

test('oauth connect routes reject requests without tenant context', async () => {
  const request = new Request('https://aries.example.com/api/oauth/facebook/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_id: 'forged-tenant' }),
  });

  const response = await handleIntegrationsConnect(request, 'facebook', async () => {
    throw new Error('Authentication required.');
  });
  const body = (await response.json()) as {
    status: string;
    reason: string;
    message: string;
  };

  assert.equal(response.status, 403);
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'tenant_context_required');
});

test('oauth disconnect routes ignore forged connection_id and disconnect only the authenticated tenant provider', async () => {
  resetOauthStore();
  seedConnectedProvider({
    tenantId: 'tenant_real',
    provider: 'facebook',
    connectionId: 'conn_real',
    updatedAt: '2026-03-16T00:00:00.000Z',
  });
  seedConnectedProvider({
    tenantId: 'tenant_other',
    provider: 'facebook',
    connectionId: 'conn_other',
    updatedAt: '2026-03-16T00:00:00.000Z',
  });

  const response = await handleIntegrationsDisconnect(
    new Request('https://aries.example.com/api/auth/oauth/facebook/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'facebook', connection_id: 'conn_other', tenant_id: 'tenant_other' }),
    }),
    async () => ({
      userId: 'user_123',
      tenantId: 'tenant_real',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    })
  );
  const body = (await response.json()) as {
    broker_status: string;
    connection_id: string;
    disconnected: boolean;
  };

  assert.equal(response.status, 200);
  assert.equal(body.broker_status, 'ok');
  assert.equal(body.connection_id, 'conn_real');
  assert.equal(body.disconnected, true);
  assert.equal(oauthStore().connectionsById.get('conn_other')?.connection_status, 'connected');
});

test('oauth reconnect routes ignore forged connection_id and use the authenticated tenant provider connection', async () => {
  resetOauthStore();
  seedConnectedProvider({
    tenantId: 'tenant_real',
    provider: 'facebook',
    connectionId: 'conn_real',
    updatedAt: '2026-03-16T00:00:00.000Z',
    grantedScopes: ['pages_manage_posts'],
  });
  seedConnectedProvider({
    tenantId: 'tenant_other',
    provider: 'facebook',
    connectionId: 'conn_other',
    updatedAt: '2026-03-16T00:00:00.000Z',
    grantedScopes: ['pages_read_engagement'],
  });

  const response = await handleOauthReconnect(
    new Request('https://aries.example.com/api/auth/oauth/facebook/reconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        connection_id: 'conn_other',
        redirect_uri: 'https://forged.example.com/callback',
        scopes: ['pages_manage_posts'],
      }),
    }),
    'facebook',
    async () => ({
      userId: 'user_123',
      tenantId: 'tenant_real',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    })
  );
  const body = (await response.json()) as {
    broker_status: string;
    connection_id: string;
    authorization_url: string;
  };

  assert.equal(response.status, 200);
  assert.equal(body.broker_status, 'ok');
  assert.equal(body.connection_id, 'conn_real');
  assert.match(body.authorization_url, /redirect_uri=https%3A%2F%2Faries\.example\.com%2Fapi%2Fauth%2Foauth%2Ffacebook%2Fcallback/);
  assert.equal(oauthStore().pendingByState.size, 1);
  assert.equal(oauthStore().connectionsById.get('conn_other')?.connection_status, 'connected');
});

test('oauth reconnect routes reject requests without tenant context', async () => {
  resetOauthStore();
  const response = await handleOauthReconnect(
    new Request('https://aries.example.com/api/auth/oauth/facebook/reconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connection_id: 'conn_other' }),
    }),
    'facebook',
    async () => {
      throw new Error('Authentication required.');
    }
  );
  const body = (await response.json()) as {
    status: string;
    reason: string;
  };

  assert.equal(response.status, 403);
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'tenant_context_required');
});

test('oauth callback redirects browser requests to the branded OAuth screen', async () => {
  resetOauthStore();
  oauthStore().pendingByState.set('state_valid123', {
    state: 'state_valid123',
    provider: 'facebook',
    tenant_id: 'tenant_real',
    redirect_uri: 'https://aries.example.com/api/auth/oauth/facebook/callback',
    scopes: ['pages_manage_posts'],
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  });

  const previousAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://aries.example.com';

  try {
    const response = await handleOauthCallbackHttp(
      new Request('https://aries.example.com/api/auth/oauth/facebook/callback?code=oauth_code&state=state_valid123', {
        headers: {
          accept: 'text/html,application/xhtml+xml',
        },
      }),
      'facebook'
    );

    assert.equal(response.status, 302);
    const location = response.headers.get('location') || '';
    assert.match(location, /^https:\/\/aries\.example\.com\/oauth\/connect\/facebook\?/);
    assert.match(location, /result=connected/);
  } finally {
    if (previousAppBaseUrl === undefined) {
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = previousAppBaseUrl;
    }
  }
});
