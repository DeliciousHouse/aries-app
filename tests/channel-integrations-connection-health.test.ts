import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { handleComposioList } from '@/app/api/integrations/composio/handlers';
import type { AccountConnectionProvider } from '@/backend/integrations/providers/interfaces';
import type { ConnectedAccount, IntegrationPlatform } from '@/backend/integrations/providers/types';
import type { TenantRole } from '@/lib/tenant-context';

const screenSource = readFileSync(
  new URL('../frontend/integrations/composio-connections-screen.tsx', import.meta.url),
  'utf8',
);

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

function provider(row: ConnectedAccount): AccountConnectionProvider {
  return {
    kind: 'composio',
    async listConnections() { return [row]; },
    async createConnectLink() { throw new Error('not used'); },
    async getConnection() { return row; },
    async disconnectConnection() { return { disconnected: false }; },
    async refreshConnectionStatus(_externalUserId, _platform: IntegrationPlatform) { return row; },
  };
}

test('Connections health API renders live connection status and last successful post from tenant-scoped data', async () => {
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

  const response = await handleComposioList(tenantLoader, provider(connection('reauthorization_required')), db);
  const body = await response.json() as {
    connections: Array<{ platform: string; status: string; lastSuccessfulPostAt: string | null }>;
  };
  const facebook = body.connections.find((item) => item.platform === 'facebook');

  assert.equal(response.status, 200);
  assert.equal(facebook?.status, 'reauthorization_required');
  assert.equal(facebook?.lastSuccessfulPostAt, '2026-08-11T09:30:00.000Z');
  assert.equal(seen.length, 1, 'last-publish data must be loaded in one batch');
  assert.deepEqual(seen[0]?.params, [61]);
  assert.match(seen[0]?.sql ?? '', /sp\.tenant_id = \$1/i);
  assert.match(seen[0]?.sql ?? '', /spd\.status = 'dispatched'/i);
});

test('Connections health API does not leak database failures to customers', async () => {
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

test('Connections health screen names the view, shows last post, and reconnects through the existing connect flow', () => {
  assert.match(screenSource, />Connections health</);
  assert.match(screenSource, /Last successful post/);
  assert.match(screenSource, /reauthorization_required[\s\S]*Reconnect/);
  assert.match(screenSource, /\/api\/integrations\/composio\/\$\{platform\}\/connect/);
});
