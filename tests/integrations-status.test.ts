import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveIntegrationSyncTelemetry,
  handleIntegrationsGet,
} from '../app/api/integrations/handlers';
import { handlePlatformConnectionsGet } from '../app/api/platform-connections/handlers';
import { oauthStore } from '../backend/integrations/connect';
import pool from '../lib/db';

const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');

const META_ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_PAGE_ID',
  'META_ACCESS_TOKEN',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
] as const;

function withMetaEnv(fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of META_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }
  process.env.META_APP_ID = 'test-app-id';
  process.env.META_APP_SECRET = 'test-app-secret';
  // Instagram is env_managed — needs META_PAGE_ID + META_ACCESS_TOKEN to show as
  // 'connected' (env_managed path) rather than 'misconfigured' (missing env path).
  process.env.META_PAGE_ID = 'test-page-id';
  process.env.META_ACCESS_TOKEN = 'test-access-token';
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = BASE64_KEY;

  return fn().finally(() => {
    for (const key of META_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function resetOauthStore(): void {
  const store = oauthStore();
  store.pendingByState.clear();
  store.connectionsById.clear();
  store.connectedByTenantProvider.clear();
}

type InsightsAccountFixture = {
  tenant_id: string;
  platform: string;
  external_account_id: string;
  last_synced_at: Date | string | null;
  latest_status: 'ok' | 'partial' | 'failed' | null;
};

type QueryObservation = {
  sql: string;
  params: unknown[];
};

/**
 * Build a pool.query mock that services SELECT queries from oauth-db.ts.
 * Tenant IDs and connection IDs must be numeric strings (toTenantIdInt requirement).
 */
function makeQueryMock(connections: Array<{
  id: string;
  tenant_id: string;
  provider: string;
  status: string;
  granted_scopes: string[];
  token_expires_at: string | null;
  refresh_expires_at: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  external_account_id: string | null;
  external_account_name: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}>, insightsAccounts: InsightsAccountFixture[] = [], seenQueries: QueryObservation[] = []) {
  return async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    seenQueries.push({ sql: text, params });

    if (text.includes('FROM insights_accounts')) {
      const tenantId = String(params[0]);
      const rows = insightsAccounts
        .filter((row) => row.tenant_id === tenantId)
        .map(({ tenant_id: _tenantId, ...row }) => row);
      return { rows, rowCount: rows.length };
    }

    // SELECT by tenant_id + provider (dbGetConnection)
    if (text.includes('FROM oauth_connections') && text.includes('WHERE tenant_id = $1 AND provider = $2')) {
      const tenantIdInt = Number(params[0]);
      const provider = String(params[1]);
      const row = connections.find(
        (c) => Number(c.tenant_id) === tenantIdInt && c.provider === provider
      );
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // SELECT by id (dbGetConnectionById)
    if (text.includes('FROM oauth_connections') && text.includes('WHERE id = $1')) {
      const idInt = Number(params[0]);
      const row = connections.find((c) => Number(c.id) === idInt);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // Writes — treat as no-ops
    if (
      text.includes('INSERT INTO oauth_connections') ||
      text.includes('INSERT INTO oauth_audit_events') ||
      text.includes('INSERT INTO oauth_tokens') ||
      text.includes('DELETE FROM') ||
      text.includes('UPDATE oauth_') ||
      text.includes('oauth_tokens')
    ) {
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in test mock: ${text}`);
  };
}

test('integration sync telemetry uses the shared two-tick freshness contract and normalizes invalid dates', () => {
  const now = new Date('2026-07-19T12:00:00.000Z').getTime();
  const staleAfterMs = 60 * 60_000;

  assert.deepEqual(
    deriveIntegrationSyncTelemetry('2026-07-19T11:50:00.000Z', 'ok', now, staleAfterMs),
    { lastSyncedAt: '2026-07-19T11:50:00.000Z', syncState: 'current' },
  );
  assert.equal(
    deriveIntegrationSyncTelemetry('2026-07-19T10:59:59.000Z', 'ok', now, staleAfterMs).syncState,
    'stale',
  );
  assert.equal(
    deriveIntegrationSyncTelemetry('2026-07-19T11:50:00.000Z', 'failed', now, staleAfterMs).syncState,
    'stale',
  );
  assert.deepEqual(
    deriveIntegrationSyncTelemetry('not-a-timestamp', 'ok', now, staleAfterMs),
    { lastSyncedAt: null, syncState: 'never_synced' },
  );
  assert.deepEqual(
    deriveIntegrationSyncTelemetry(null, null, now, staleAfterMs),
    { lastSyncedAt: null, syncState: 'never_synced' },
  );
});

test('/api/platform-connections derives token health from token expiry, not connection activity time', async (t) => {
  await withMetaEnv(async () => {
    resetOauthStore();

    const futureExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    const connRow = {
      id: '101',
      tenant_id: '123',
      provider: 'facebook',
      status: 'connected',
      granted_scopes: [] as string[],
      token_expires_at: futureExpiry,
      refresh_expires_at: null,
      connected_at: '2020-01-01T00:00:00.000Z',
      disconnected_at: null,
      external_account_id: null,
      external_account_name: null,
      last_error_code: null,
      last_error_message: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };
    t.mock.method(pool, 'query', makeQueryMock([connRow]) as typeof pool.query);

    const response = await handlePlatformConnectionsGet(async () => ({
      userId: 'user_123',
      tenantId: '123',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
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
});

test('/api/integrations loads one tenant-scoped, account-keyed sync telemetry batch', async (t) => {
  await withMetaEnv(async () => {
    resetOauthStore();

    const futureExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    const facebookLastSyncedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const connRows = [
      {
        id: '101',
        tenant_id: '123',
        provider: 'facebook',
        status: 'connected',
        granted_scopes: [] as string[],
        token_expires_at: futureExpiry,
        refresh_expires_at: null,
        connected_at: '2020-01-01T00:00:00.000Z',
        disconnected_at: null,
        external_account_id: 'current-page',
        external_account_name: 'Current Page',
        last_error_code: null,
        last_error_message: null,
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-01-01T00:00:00.000Z',
      },
      {
        id: '102',
        tenant_id: '123',
        provider: 'instagram',
        status: 'connected',
        granted_scopes: [] as string[],
        token_expires_at: null,
        refresh_expires_at: null,
        connected_at: '2020-01-01T00:00:00.000Z',
        disconnected_at: null,
        external_account_id: null,
        external_account_name: null,
        last_error_code: null,
        last_error_message: null,
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-01-01T00:00:00.000Z',
      },
    ];
    const seenQueries: QueryObservation[] = [];
    t.mock.method(pool, 'query', makeQueryMock(connRows, [
      {
        tenant_id: '123',
        platform: 'facebook',
        external_account_id: 'current-page',
        last_synced_at: facebookLastSyncedAt,
        latest_status: 'ok',
      },
      {
        tenant_id: '123',
        platform: 'facebook',
        external_account_id: 'previous-page',
        last_synced_at: new Date(Date.now() - 60_000),
        latest_status: 'ok',
      },
      {
        tenant_id: '999',
        platform: 'facebook',
        external_account_id: 'current-page',
        last_synced_at: new Date(Date.now() - 30_000),
        latest_status: 'ok',
      },
    ], seenQueries) as typeof pool.query);

    const response = await handleIntegrationsGet(async () => ({
      userId: 'user_123',
      tenantId: '123',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
    const body = (await response.json()) as {
      status: string;
      cards: Array<{
        platform: string;
        health: string;
        last_synced_at: string | null;
        sync_state?: string;
        expires_at?: string | null;
      }>;
    };

    assert.equal(response.status, 200);

    const facebook = body.cards.find((card) => card.platform === 'facebook');
    assert.equal(facebook?.health, 'healthy');
    assert.equal(facebook?.last_synced_at, facebookLastSyncedAt);
    assert.equal(facebook?.sync_state, 'current');

    const instagram = body.cards.find((card) => card.platform === 'instagram');
    assert.equal(instagram?.health, 'unknown');
    assert.equal(instagram?.expires_at ?? null, null);

    const insightsQueries = seenQueries.filter(({ sql }) => sql.includes('FROM insights_accounts'));
    assert.equal(insightsQueries.length, 1, 'sync timing must use one batch query, not a per-card fan-out');
    assert.deepEqual(insightsQueries[0]?.params, [123]);
    assert.match(insightsQueries[0]?.sql ?? '', /a\.tenant_id\s*=\s*\$1/i);
    assert.match(insightsQueries[0]?.sql ?? '', /external_account_id/i);
    assert.doesNotMatch(insightsQueries[0]?.sql ?? '', /MAX\(last_sync_at\)|GROUP BY platform/i);
  });
});

test('/api/integrations marks expired connections as reauthorization-required attention items', async (t) => {
  await withMetaEnv(async () => {
    resetOauthStore();

    const expiredAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const connRow = {
      id: '101',
      tenant_id: '123',
      provider: 'facebook',
      status: 'connected',
      granted_scopes: [] as string[],
      token_expires_at: expiredAt,
      refresh_expires_at: null,
      connected_at: '2020-01-01T00:00:00.000Z',
      disconnected_at: null,
      external_account_id: null,
      external_account_name: null,
      last_error_code: null,
      last_error_message: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };
    t.mock.method(pool, 'query', makeQueryMock([connRow]) as typeof pool.query);

    const response = await handleIntegrationsGet(async () => ({
      userId: 'user_123',
      tenantId: '123',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
    const body = (await response.json()) as {
      status: string;
      summary: {
        attention_required: number;
      };
      cards: Array<{
        platform: string;
        connection_state: string;
        available_actions: string[];
      }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.summary.attention_required, 1);

    const facebook = body.cards.find((card) => card.platform === 'facebook');
    assert.equal(facebook?.connection_state, 'reauth_required');
    assert.deepEqual(facebook?.available_actions, ['reconnect', 'view_permissions']);
  });
});
