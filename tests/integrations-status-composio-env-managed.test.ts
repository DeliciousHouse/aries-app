import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIntegrationsGet } from '../app/api/integrations/handlers';
import { oauthStatusAsync } from '../backend/integrations/status';
import { oauthStore } from '../backend/integrations/connect';
import pool from '../lib/db';

// #808: the env-managed branch of oauthStatusAsync (Instagram, connectionMode
// 'env_managed' in oauth-provider-runtime.ts) must become per-tenant-aware when
// Composio is the active account-connection provider, instead of reporting
// EVERY tenant as "connected" whenever process-wide META_PAGE_ID/META_ACCESS_TOKEN
// are set. When Composio is disabled the branch must stay byte-identical.

const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');

const META_ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_PAGE_ID',
  'META_ACCESS_TOKEN',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
] as const;

const COMPOSIO_ENV_KEYS = ['COMPOSIO_ENABLED', 'COMPOSIO_API_KEY'] as const;

const ALL_ENV_KEYS = [...META_ENV_KEYS, ...COMPOSIO_ENV_KEYS] as const;

function withEnv(overrides: Partial<Record<(typeof ALL_ENV_KEYS)[number], string>>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of ALL_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  // Instagram is env_managed — needs META_PAGE_ID + META_ACCESS_TOKEN to reach
  // the env-managed branch (rather than 'misconfigured' for missing env).
  process.env.META_APP_ID = 'test-app-id';
  process.env.META_APP_SECRET = 'test-app-secret';
  process.env.META_PAGE_ID = 'test-page-id';
  process.env.META_ACCESS_TOKEN = 'test-access-token';
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = BASE64_KEY;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return fn().finally(() => {
    for (const key of ALL_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function withComposioEnabledEnv(fn: () => Promise<void>): Promise<void> {
  return withEnv({ COMPOSIO_ENABLED: 'true', COMPOSIO_API_KEY: 'test-composio-key' }, fn);
}

function withComposioDisabledEnv(fn: () => Promise<void>): Promise<void> {
  return withEnv({}, fn);
}

function resetOauthStore(): void {
  const store = oauthStore();
  store.pendingByState.clear();
  store.connectionsById.clear();
  store.connectedByTenantProvider.clear();
}

interface ConnectedAccountRowFixture {
  id: string;
  tenant_id: string;
  external_user_id: string;
  platform: string;
  provider: string;
  connected_account_id: string | null;
  auth_config_id: string | null;
  external_account_id: string | null;
  external_account_name: string | null;
  status: string;
  capabilities_json: unknown;
  last_capability_check_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Build a pool.query mock that services both the legacy oauth_connections
 * lookup (oauth-db.ts::dbGetConnection, used by oauth-mode platforms like
 * Facebook) and the Composio connected_accounts lookup
 * (composio/connection-store.ts::getConnectionRow, used by the fixed
 * env-managed Instagram branch). Mirrors the makeQueryMock idiom in
 * tests/integrations-status.test.ts.
 */
function makeQueryMock(options: {
  connectedAccounts?: ConnectedAccountRowFixture[];
  throwOnConnectedAccounts?: Error;
}) {
  const connectedAccounts = options.connectedAccounts ?? [];

  return async (sql: string, params: unknown[] = []) => {
    const text = String(sql);

    // Composio per-tenant connection lookup (connection-store.ts::getConnectionRow)
    if (text.includes('FROM connected_accounts') && text.includes('WHERE tenant_id = $1 AND platform = $2')) {
      if (options.throwOnConnectedAccounts) {
        throw options.throwOnConnectedAccounts;
      }
      const tenantId = String(params[0]);
      const platform = String(params[1]);
      const row = connectedAccounts.find((c) => c.tenant_id === tenantId && c.platform === platform);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // Legacy oauth_connections lookup (oauth-db.ts::dbGetConnection) — always
    // "no row" in these tests, since only Instagram (env-managed) is exercised.
    if (text.includes('FROM oauth_connections') && text.includes('WHERE tenant_id = $1 AND provider = $2')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FROM oauth_connections') && text.includes('WHERE id = $1')) {
      return { rows: [], rowCount: 0 };
    }

    // Writes — treat as no-ops.
    if (
      text.includes('INSERT INTO') ||
      text.includes('DELETE FROM') ||
      text.includes('UPDATE ')
    ) {
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in test mock: ${text}`);
  };
}

test('#808: Composio ON + zero connected_accounts rows -> oauthStatusAsync reports Instagram disconnected, not env-managed connected', async (t) => {
  await withComposioEnabledEnv(async () => {
    resetOauthStore();
    t.mock.method(pool, 'query', makeQueryMock({ connectedAccounts: [] }) as typeof pool.query);

    const status = await oauthStatusAsync('instagram', '999');
    assert.ok(!('broker_status' in status), 'expected a status shape, not a broker error');
    assert.equal(status.connection_status, 'disconnected');
    assert.equal(status.status_reason, 'connection_not_found');
  });
});

test('#808: Composio ON + zero connected_accounts rows -> /api/integrations Instagram card is not_connected with no disconnect action', async (t) => {
  await withComposioEnabledEnv(async () => {
    resetOauthStore();
    t.mock.method(pool, 'query', makeQueryMock({ connectedAccounts: [] }) as typeof pool.query);

    const response = await handleIntegrationsGet(async () => ({
      userId: 'user_999',
      tenantId: '999',
      tenantSlug: 'brand-new-workspace',
      role: 'tenant_admin',
    }));
    const body = (await response.json()) as {
      cards: Array<{ platform: string; connection_state: string; available_actions: string[] }>;
    };

    assert.equal(response.status, 200);
    const instagram = body.cards.find((card) => card.platform === 'instagram');
    assert.equal(instagram?.connection_state, 'not_connected');
    assert.ok(
      !instagram?.available_actions.includes('disconnect'),
      'a tenant with zero connections must not see a Disconnect action',
    );
  });
});

test('#808: Composio ON + a connected_accounts row with status=connected -> oauthStatusAsync reports connected (tenant-15 preservation)', async (t) => {
  await withComposioEnabledEnv(async () => {
    resetOauthStore();
    const connRow: ConnectedAccountRowFixture = {
      id: '501',
      tenant_id: '15',
      external_user_id: 'tenant-15',
      platform: 'instagram',
      provider: 'composio',
      connected_account_id: 'ca_abc123',
      auth_config_id: 'ac_xyz789',
      external_account_id: 'ig_17841400000000000',
      external_account_name: 'Aries AI',
      status: 'connected',
      capabilities_json: null,
      last_capability_check_at: null,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    };
    t.mock.method(pool, 'query', makeQueryMock({ connectedAccounts: [connRow] }) as typeof pool.query);

    const status = await oauthStatusAsync('instagram', '15');
    assert.ok(!('broker_status' in status), 'expected a status shape, not a broker error');
    assert.equal(status.connection_status, 'connected');
    assert.equal(status.status_reason, 'env_managed');
    assert.equal(status.external_account_id, 'ig_17841400000000000');
    assert.equal(status.external_account_name, 'Aries AI');
  });
});

test('#808: Composio OFF -> Instagram env-managed branch stays unconditionally connected (legacy behavior unchanged)', async (t) => {
  await withComposioDisabledEnv(async () => {
    resetOauthStore();
    // No connected_accounts/oauth_connections row exists anywhere — if the fix
    // regressed the Composio-disabled path, this proves it: the legacy branch
    // must never touch the DB and must always report connected.
    t.mock.method(pool, 'query', makeQueryMock({ connectedAccounts: [] }) as typeof pool.query);

    const status = await oauthStatusAsync('instagram', '999');
    assert.ok(!('broker_status' in status), 'expected a status shape, not a broker error');
    assert.equal(status.connection_status, 'connected');
    assert.equal(status.status_reason, 'env_managed');
  });
});

test('#808: Composio ON + connected_accounts read throws -> oauthStatusAsync rejects (no confident false status)', async (t) => {
  await withComposioEnabledEnv(async () => {
    resetOauthStore();
    t.mock.method(
      pool,
      'query',
      makeQueryMock({ throwOnConnectedAccounts: new Error('simulated connection pool failure') }) as typeof pool.query,
    );

    await assert.rejects(
      () => oauthStatusAsync('instagram', '999'),
      /simulated connection pool failure/,
    );
  });
});
