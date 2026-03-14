import assert from 'node:assert/strict';
import test from 'node:test';

import { GET as getIntegrations } from '../app/api/integrations/route';
import { GET as getPlatformConnections } from '../app/api/platform-connections/route';
import { oauthStore } from '../backend/integrations/connect';

function seedConnectedProvider(input: {
  tenantId: string;
  provider: 'facebook' | 'instagram';
  connectionId: string;
  updatedAt: string;
  tokenExpiresAt?: string;
}) {
  const store = oauthStore();
  store.connectionsById.set(input.connectionId, {
    connection_id: input.connectionId,
    provider: input.provider,
    tenant_id: input.tenantId,
    connection_status: 'connected',
    granted_scopes: [],
    created_at: input.updatedAt,
    updated_at: input.updatedAt,
    token_expires_at: input.tokenExpiresAt,
  });
  store.connectedByTenantProvider.set(`${input.tenantId}::${input.provider}`, input.connectionId);
}

function resetOauthStore(): void {
  const store = oauthStore();
  store.pendingByState.clear();
  store.connectionsById.clear();
  store.connectedByTenantProvider.clear();
}

test('/api/platform-connections derives token health from token expiry, not connection activity time', async () => {
  resetOauthStore();

  const futureExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  seedConnectedProvider({
    tenantId: 'tenant_123',
    provider: 'facebook',
    connectionId: 'conn_facebook',
    updatedAt: '2020-01-01T00:00:00.000Z',
    tokenExpiresAt: futureExpiry,
  });

  const response = await getPlatformConnections(
    new Request('http://localhost/api/platform-connections?tenant_id=tenant_123'),
  );
  const body = (await response.json()) as {
    status: string;
    connections: Array<{
      provider: string;
      token_health: string;
      expires_at?: string;
    }>;
  };

  assert.equal(response.status, 200);
  const facebook = body.connections.find((connection) => connection.provider === 'facebook');
  assert.equal(facebook?.token_health, 'healthy');
  assert.equal(facebook?.expires_at, futureExpiry);
});

test('/api/integrations leaves sync timing unknown unless real sync telemetry exists', async () => {
  resetOauthStore();

  seedConnectedProvider({
    tenantId: 'tenant_123',
    provider: 'facebook',
    connectionId: 'conn_facebook',
    updatedAt: '2020-01-01T00:00:00.000Z',
    tokenExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
  });
  seedConnectedProvider({
    tenantId: 'tenant_123',
    provider: 'instagram',
    connectionId: 'conn_instagram',
    updatedAt: '2020-01-01T00:00:00.000Z',
  });

  const response = await getIntegrations(
    new Request('http://localhost/api/integrations?tenant_id=tenant_123'),
  );
  const body = (await response.json()) as {
    status: string;
    cards: Array<{
      platform: string;
      health: string;
      last_synced_at: string | null;
      expires_at?: string | null;
    }>;
  };

  assert.equal(response.status, 200);

  const facebook = body.cards.find((card) => card.platform === 'facebook');
  assert.equal(facebook?.health, 'healthy');
  assert.equal(facebook?.last_synced_at, null);

  const instagram = body.cards.find((card) => card.platform === 'instagram');
  assert.equal(instagram?.health, 'unknown');
  assert.equal(instagram?.expires_at ?? null, null);
});
