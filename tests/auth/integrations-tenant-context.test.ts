import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIntegrationsGet, handleIntegrationsDisconnect, handleIntegrationsSync } from '../../app/api/integrations/handlers';
import { handlePlatformConnectionsGet } from '../../app/api/platform-connections/handlers';
import { oauthStore } from '../../backend/integrations/connect';

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

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

test('integrations GET ignores forged tenant_id query input and uses authenticated tenant context', async () => {
  resetOauthStore();
  seedConnectedProvider({
    tenantId: 'tenant_real',
    provider: 'facebook',
    connectionId: 'conn_real',
    updatedAt: '2026-03-16T00:00:00.000Z',
  });

  const response = await handleIntegrationsGet(async () => ({
    userId: 'user_123',
    tenantId: 'tenant_real',
    tenantSlug: 'acme',
    role: 'tenant_admin',
  }));
  const body = (await response.json()) as {
    status: string;
    cards: Array<{ platform: string; connection_state: string }>;
  };

  assert.equal(response.status, 200);
  const facebook = body.cards.find((card) => card.platform === 'facebook');
  assert.equal(facebook?.connection_state, 'connected');
});

test('platform connections GET returns authenticated tenant data instead of forged tenant_id query input', async () => {
  resetOauthStore();
  seedConnectedProvider({
    tenantId: 'tenant_real',
    provider: 'facebook',
    connectionId: 'conn_real',
    updatedAt: '2026-03-16T00:00:00.000Z',
  });

  const response = await handlePlatformConnectionsGet(async () => ({
    userId: 'user_123',
    tenantId: 'tenant_real',
    tenantSlug: 'acme',
    role: 'tenant_admin',
  }));
  const body = (await response.json()) as {
    status: string;
    connections: Array<{ provider: string; tenant_id: string; connection_id: string }>;
  };

  assert.equal(response.status, 200);
  const facebook = body.connections.find((connection) => connection.provider === 'facebook');
  assert.equal(facebook?.tenant_id, 'tenant_real');
  assert.equal(facebook?.connection_id, 'conn_real');
});

test('integrations disconnect ignores forged request tenant_id and disconnects only within authenticated tenant', async () => {
  resetOauthStore();
  seedConnectedProvider({
    tenantId: 'tenant_real',
    provider: 'facebook',
    connectionId: 'conn_real',
    updatedAt: '2026-03-16T00:00:00.000Z',
  });

  const response = await handleIntegrationsDisconnect(
    new Request('http://localhost/api/integrations/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'facebook', tenant_id: 'forged_tenant', confirm: true }),
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
  assert.equal(oauthStore().connectedByTenantProvider.has('tenant_real::facebook'), false);
});

test('integrations sync uses authenticated tenant context and rejects missing tenant context', async () => {
  resetOauthStore();
  let captured: Record<string, unknown> | null = null;
  setOpenClawTestInvoker((payload) => {
    captured = payload;
    return {
      ok: true,
      status: 'ok',
      output: [{
        status: 'not_implemented',
        code: 'workflow_missing_for_route',
        route: 'integrations.sync',
        message: 'No production-parity OpenClaw workflow is installed for this route yet.',
      }],
      requiresApproval: null,
    };
  });
  const accepted = await handleIntegrationsSync(
    new Request('http://localhost/api/integrations/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'facebook', tenant_id: 'forged_tenant' }),
    }),
    async () => ({
      userId: 'user_123',
      tenantId: 'tenant_real',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    })
  );
  const acceptedBody = (await accepted.json()) as {
    status: string;
    reason: string;
    route: string;
  };

  assert.equal(accepted.status, 501);
  assert.equal(acceptedBody.status, 'error');
  assert.equal(acceptedBody.reason, 'workflow_missing_for_route');
  assert.equal(acceptedBody.route, 'integrations.sync');
  assert.equal(JSON.parse(String((captured as any)?.args?.argsJson)).tenant_id, 'tenant_real');

  const rejected = await handleIntegrationsSync(
    new Request('http://localhost/api/integrations/sync', { method: 'POST' }),
    async () => {
      throw new Error('Authentication required.');
    }
  );
  const rejectedBody = (await rejected.json()) as {
    status: string;
    reason: string;
    message: string;
  };

  assert.equal(rejected.status, 403);
  assert.equal(rejectedBody.status, 'error');
  assert.equal(rejectedBody.reason, 'tenant_context_required');
  clearOpenClawTestInvoker();
});
