import assert from 'node:assert/strict';
import test from 'node:test';

import { handleComposioList } from '@/app/api/integrations/composio/handlers';
import type { AccountConnectionProvider } from '@/backend/integrations/providers/interfaces';
import type { ConnectedAccount, IntegrationPlatform } from '@/backend/integrations/providers/types';
import { mapComposioStatus } from '@/backend/integrations/composio/status-map';
import type { TenantRole } from '@/lib/tenant-context';

const tenantLoader = async () => ({
  userId: 'user_61',
  tenantId: '61',
  tenantSlug: 'customer-61',
  role: 'tenant_admin' as TenantRole,
});

function connection(status: ConnectedAccount['status']): ConnectedAccount {
  return {
    id: '61',
    tenantId: '61',
    externalUserId: 'aries-tenant-61',
    platform: 'facebook',
    provider: 'composio',
    connectedAccountId: 'ca_61',
    authConfigId: null,
    externalAccountId: 'page_61',
    externalAccountName: 'Customer Page',
    status,
    capabilities: null,
    lastCapabilityCheckAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  };
}

function provider(
  row: ConnectedAccount,
  refreshed: ConnectedAccount = row,
): AccountConnectionProvider {
  let current = row;
  return {
    kind: 'composio',
    async listConnections() { return [current]; },
    async createConnectLink() { throw new Error('not used'); },
    async getConnection() { return current; },
    async disconnectConnection() { return { disconnected: false }; },
    async refreshConnectionStatus(_externalUserId, _platform: IntegrationPlatform) {
      current = refreshed;
      return current;
    },
  };
}

test('live provider statuses derive the customer-facing connection state', () => {
  assert.equal(mapComposioStatus('ACTIVE'), 'connected');
  assert.equal(mapComposioStatus('INITIATED'), 'pending');
  assert.equal(mapComposioStatus('EXPIRED'), 'reauthorization_required');
  assert.equal(mapComposioStatus('REVOKED'), 'reauthorization_required');
});

test('connection health returns live status, last successful post, and reauthorization route', async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      return {
        rows: [{ platform: 'facebook', last_successful_post_at: '2026-08-11T09:30:00.000Z' }],
        rowCount: 1,
      };
    },
  };

  const response = await handleComposioList(
    tenantLoader,
    provider(connection('reauthorization_required')),
    db,
  );
  const body = await response.json() as {
    connections: Array<{
      platform: string;
      status: string;
      lastSuccessfulPostAt: string | null;
      reauthorizationPath: string;
    }>;
  };
  const facebook = body.connections.find((item) => item.platform === 'facebook');

  assert.equal(response.status, 200);
  assert.equal(facebook?.status, 'reauthorization_required');
  assert.equal(facebook?.lastSuccessfulPostAt, '2026-08-11T09:30:00.000Z');
  assert.equal(facebook?.reauthorizationPath, '/api/integrations/composio/facebook/connect');
  assert.equal(seen.length, 1, 'last-publish data must be loaded in one batch');
  assert.deepEqual(seen[0]?.params, [61]);
  assert.match(seen[0]?.sql ?? '', /sp\.tenant_id = \$1/i);
  assert.match(seen[0]?.sql ?? '', /spd\.status = 'dispatched'/i);
});

test('connection health refreshes a stored connected account before returning live status', async () => {
  const response = await handleComposioList(
    tenantLoader,
    provider(connection('connected'), connection('reauthorization_required')),
    { query: async () => ({ rows: [], rowCount: 0 }) },
  );
  const body = await response.json() as {
    connections: Array<{ platform: string; status: string }>;
  };

  assert.equal(response.status, 200);
  assert.equal(
    body.connections.find((item) => item.platform === 'facebook')?.status,
    'reauthorization_required',
  );
});

test('connection health does not leak database failures', async () => {
  const response = await handleComposioList(tenantLoader, provider(connection('connected')), {
    query: async () => {
      throw new Error('postgres host db.internal.local rejected secret role');
    },
  });
  const text = await response.text();

  assert.equal(response.status, 500);
  assert.match(text, /connection_health_unavailable/);
  assert.doesNotMatch(text, /postgres|db\.internal|secret role/i);
});
