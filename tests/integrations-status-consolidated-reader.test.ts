import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIntegrationsPageDataAsync } from '../app/api/integrations/handlers';
import { oauthStatusAsync } from '../backend/integrations/status';
import { oauthStore } from '../backend/integrations/connect';
import pool from '../lib/db';

// Reader consolidation: when an account-connection provider (Composio) is
// active, connected_accounts is the SINGLE source of truth for every
// IntegrationPlatform (facebook, instagram, linkedin, x, youtube, reddit) —
// including platforms whose legacy OAuth env is absent (x, reddit), which must
// NOT short-circuit to 'misconfigured'. slack/openai are NOT integration
// platforms and keep the legacy oauth_connections broker. With Composio
// disabled every platform falls through to the byte-identical legacy path.
//
// These cases mirror the live conflicts the fix targets: t15/facebook
// (oauth=disconnected vs ca=connected), t15/linkedin (oauth=pending vs
// ca=connected), and x/reddit which have no oauth_connections row at all.

const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');

// Every env var either fixture toggles. Cleared before each run so a case that
// deliberately omits (e.g.) X_CLIENT_ID sees a truly empty value.
const MANAGED_ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_PAGE_ID',
  'META_ACCESS_TOKEN',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'X_CLIENT_ID',
  'X_CLIENT_SECRET',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
  'COMPOSIO_ENABLED',
  'COMPOSIO_API_KEY',
] as const;

function withEnv(
  overrides: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  // Base env every case shares: Meta app creds + Instagram env-managed creds +
  // token encryption key. Individual cases layer platform creds / Composio via
  // overrides.
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
    for (const key of MANAGED_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function withComposioEnabled(
  overrides: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  return withEnv({ COMPOSIO_ENABLED: 'true', COMPOSIO_API_KEY: 'test-composio-key', ...overrides }, fn);
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

interface OauthConnectionRowFixture {
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
}

type QueryObservation = { sql: string; params: unknown[] };

/**
 * pool.query mock servicing BOTH stores: connected_accounts
 * (connection-store.ts::getConnectionRow) and the legacy oauth_connections
 * (oauth-db.ts::dbGetConnection). seenQueries records every SQL so a test can
 * assert which store was consulted.
 */
function makeQueryMock(options: {
  connectedAccounts?: ConnectedAccountRowFixture[];
  oauthConnections?: OauthConnectionRowFixture[];
  seenQueries?: QueryObservation[];
}) {
  const connectedAccounts = options.connectedAccounts ?? [];
  const oauthConnections = options.oauthConnections ?? [];
  const seenQueries = options.seenQueries;

  return async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    seenQueries?.push({ sql: text, params });

    // Composio per-tenant connection lookup (getConnectionRow).
    if (text.includes('FROM connected_accounts') && text.includes('WHERE tenant_id = $1 AND platform = $2')) {
      const tenantId = String(params[0]);
      const platform = String(params[1]);
      const row = connectedAccounts.find((c) => c.tenant_id === tenantId && c.platform === platform);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // Legacy oauth_connections lookup (dbGetConnection). tenant_id is numeric.
    if (text.includes('FROM oauth_connections') && text.includes('WHERE tenant_id = $1 AND provider = $2')) {
      const tenantIdInt = Number(params[0]);
      const provider = String(params[1]);
      const row = oauthConnections.find((c) => Number(c.tenant_id) === tenantIdInt && c.provider === provider);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes('FROM oauth_connections') && text.includes('WHERE id = $1')) {
      const idInt = Number(params[0]);
      const row = oauthConnections.find((c) => Number(c.id) === idInt);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (text.includes('FROM insights_accounts')) {
      return { rows: [], rowCount: 0 };
    }

    // Writes — no-ops.
    if (text.includes('INSERT INTO') || text.includes('DELETE FROM') || text.includes('UPDATE ')) {
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in test mock: ${text}`);
  };
}

function connectedAccount(overrides: Partial<ConnectedAccountRowFixture> & { tenant_id: string; platform: string }): ConnectedAccountRowFixture {
  return {
    id: '900',
    external_user_id: `tenant-${overrides.tenant_id}`,
    provider: 'composio',
    connected_account_id: 'ca_default',
    auth_config_id: 'ac_default',
    external_account_id: null,
    external_account_name: null,
    status: 'connected',
    capabilities_json: null,
    last_capability_check_at: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function legacyConnection(overrides: Partial<OauthConnectionRowFixture> & { tenant_id: string; provider: string }): OauthConnectionRowFixture {
  return {
    id: '200',
    status: 'connected',
    granted_scopes: [],
    token_expires_at: null,
    refresh_expires_at: null,
    connected_at: '2026-06-01T00:00:00.000Z',
    disconnected_at: null,
    external_account_id: null,
    external_account_name: null,
    last_error_code: null,
    last_error_message: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

// 1. Composio ON: connected_accounts wins over a stale legacy 'disconnected'
//    row (mirrors live t15/t60 facebook).
test('Composio ON: facebook connected_accounts=connected beats legacy oauth_connections=disconnected', async (t) => {
  await withComposioEnabled({}, async () => {
    resetOauthStore();
    t.mock.method(
      pool,
      'query',
      makeQueryMock({
        connectedAccounts: [
          connectedAccount({
            tenant_id: '15',
            platform: 'facebook',
            external_account_id: 'fb_page_123',
            external_account_name: 'Sugar & Leather',
            status: 'connected',
          }),
        ],
        oauthConnections: [legacyConnection({ tenant_id: '15', provider: 'facebook', status: 'disconnected' })],
      }) as typeof pool.query,
    );

    const status = await oauthStatusAsync('facebook', '15');
    assert.ok(!('broker_status' in status), 'expected a status shape');
    assert.equal(status.connection_status, 'connected');
    assert.equal(status.status_reason, 'env_managed');
    assert.equal(status.integration_id, undefined, 'consolidated path never surfaces a legacy connection_id');
    assert.equal(status.external_account_id, 'fb_page_123');
    assert.equal(status.external_account_name, 'Sugar & Leather');
  });
});

// 2. Composio ON: linkedin connected_accounts=connected beats legacy 'pending'
//    (mirrors live t15/linkedin).
test('Composio ON: linkedin connected_accounts=connected beats legacy oauth_connections=pending', async (t) => {
  await withComposioEnabled({}, async () => {
    resetOauthStore();
    t.mock.method(
      pool,
      'query',
      makeQueryMock({
        connectedAccounts: [connectedAccount({ tenant_id: '15', platform: 'linkedin', status: 'connected' })],
        oauthConnections: [legacyConnection({ tenant_id: '15', provider: 'linkedin', status: 'pending' })],
      }) as typeof pool.query,
    );

    const status = await oauthStatusAsync('linkedin', '15');
    assert.ok(!('broker_status' in status), 'expected a status shape');
    assert.equal(status.connection_status, 'connected');
    assert.equal(status.status_reason, 'env_managed');
  });
});

// 3. Composio ON: x has NO X_CLIENT_ID/SECRET, but a connected connected_accounts
//    row -> connected, NOT 'misconfigured'. Proves the guard runs BEFORE the
//    availability checks.
test('Composio ON: x with connected_accounts=connected reports connected even with no legacy X env (guard precedes availability)', async (t) => {
  await withComposioEnabled({}, async () => {
    resetOauthStore();
    // Assert the env really is absent so the test proves what it claims.
    assert.equal(process.env.X_CLIENT_ID, undefined);
    assert.equal(process.env.X_CLIENT_SECRET, undefined);
    t.mock.method(
      pool,
      'query',
      makeQueryMock({
        connectedAccounts: [
          connectedAccount({ tenant_id: '15', platform: 'x', external_account_id: 'x_acct', external_account_name: '@aries', status: 'connected' }),
        ],
      }) as typeof pool.query,
    );

    const status = await oauthStatusAsync('x', '15');
    assert.ok(!('broker_status' in status), 'expected a status shape');
    assert.equal(status.connection_status, 'connected');
    assert.notEqual(status.connection_status, 'misconfigured');
    assert.equal(status.external_account_id, 'x_acct');
  });
});

// 4. Composio ON: reddit with NO connected_accounts row -> disconnected /
//    account_provider_not_connected (not 'misconfigured', not env-managed
//    connected).
test('Composio ON: reddit with no connected_accounts row reports disconnected/account_provider_not_connected', async (t) => {
  await withComposioEnabled({}, async () => {
    resetOauthStore();
    t.mock.method(pool, 'query', makeQueryMock({ connectedAccounts: [] }) as typeof pool.query);

    const status = await oauthStatusAsync('reddit', '15');
    assert.ok(!('broker_status' in status), 'expected a status shape');
    assert.equal(status.connection_status, 'disconnected');
    // Consolidated disconnected shape carries the distinct marker (not the
    // legacy 'connection_not_found') so handlers can suppress the legacy connect.
    assert.equal(status.status_reason, 'account_provider_not_connected');
  });
});

// 5. Composio ON: slack is NOT an IntegrationPlatform -> falls through to the
//    legacy oauth_connections broker (connected_accounts never consulted).
test('Composio ON: slack falls through to the legacy oauth_connections path (not an IntegrationPlatform)', async (t) => {
  await withComposioEnabled({ SLACK_CLIENT_ID: 'slack-id', SLACK_CLIENT_SECRET: 'slack-secret' }, async () => {
    resetOauthStore();
    const seenQueries: QueryObservation[] = [];
    t.mock.method(
      pool,
      'query',
      makeQueryMock({
        // A connected_accounts row exists but MUST be ignored for slack.
        connectedAccounts: [connectedAccount({ tenant_id: '15', platform: 'slack' as string, status: 'connected' })],
        oauthConnections: [
          legacyConnection({
            id: '201',
            tenant_id: '15',
            provider: 'slack',
            status: 'connected',
            token_expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
          }),
        ],
        seenQueries,
      }) as typeof pool.query,
    );

    const status = await oauthStatusAsync('slack', '15');
    assert.ok(!('broker_status' in status), 'expected a status shape');
    assert.equal(status.connection_status, 'connected');
    assert.equal(status.integration_id, '201', 'legacy path surfaces the oauth_connections id');
    assert.equal(status.status_reason, undefined, 'legacy connected path leaves status_reason unset');
    const consultedConnectedAccounts = seenQueries.some(({ sql }) => sql.includes('FROM connected_accounts'));
    assert.equal(consultedConnectedAccounts, false, 'slack must never consult connected_accounts');
  });
});

// 6. Composio OFF: facebook reads byte-identically from the legacy
//    oauth_connections path.
test('Composio OFF: facebook reads legacy oauth_connections connected row unchanged', async (t) => {
  await withEnv({}, async () => {
    resetOauthStore();
    const seenQueries: QueryObservation[] = [];
    const futureExpiry = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    t.mock.method(
      pool,
      'query',
      makeQueryMock({
        oauthConnections: [
          legacyConnection({
            id: '301',
            tenant_id: '15',
            provider: 'facebook',
            status: 'connected',
            token_expires_at: futureExpiry,
            external_account_id: 'fb_legacy',
            external_account_name: 'Legacy Page',
          }),
        ],
        seenQueries,
      }) as typeof pool.query,
    );

    const status = await oauthStatusAsync('facebook', '15');
    assert.ok(!('broker_status' in status), 'expected a status shape');
    assert.equal(status.connection_status, 'connected');
    assert.equal(status.integration_id, '301');
    assert.equal(status.status_reason, undefined);
    assert.equal(status.external_account_id, 'fb_legacy');
    assert.equal(status.token_expires_at, futureExpiry);
    const consultedConnectedAccounts = seenQueries.some(({ sql }) => sql.includes('FROM connected_accounts'));
    assert.equal(consultedConnectedAccounts, false, 'Composio disabled must not touch connected_accounts');
  });
});

// 7. handlers: a Composio-connected facebook card carries no scopes_outdated
//    flag and offers only ['view_permissions'] (the safe env_managed affordance
//    set — disconnect/sync_now would route at the legacy broker and re-diverge).
test('handlers: Composio-connected facebook card has no scopes_outdated flag and only view_permissions', async (t) => {
  await withComposioEnabled({}, async () => {
    resetOauthStore();
    t.mock.method(
      pool,
      'query',
      makeQueryMock({
        connectedAccounts: [
          connectedAccount({
            tenant_id: '15',
            platform: 'facebook',
            external_account_id: 'fb_page_123',
            external_account_name: 'Sugar & Leather',
            status: 'connected',
          }),
        ],
      }) as typeof pool.query,
    );

    const page = (await buildIntegrationsPageDataAsync('15')) as {
      cards: Array<{ platform: string; connection_state: string; scopes_outdated?: boolean; available_actions: string[] }>;
    };
    const facebook = page.cards.find((card) => card.platform === 'facebook');
    assert.equal(facebook?.connection_state, 'connected');
    assert.equal(facebook?.scopes_outdated, undefined, 'Composio-connected facebook must not flag scopes_outdated');
    assert.deepEqual(facebook?.available_actions, ['view_permissions']);
  });
});

// 8. handlers: a Composio-brokered DISCONNECTED card (no connected_accounts row)
//    must NOT advertise the legacy 'connect' action. 'connect' routes to
//    oauthConnect (the legacy broker); a successful fallback connect would write
//    a connected oauth_connections row that no consolidated status surface reads
//    (re-diverging exactly like the rows the reconciliation cleans up), and for
//    x/reddit it dead-ends in a 503. Only 'view_permissions' is offered; the
//    authoritative connect surface is the Composio channel-integrations screen.
test('handlers: Composio-brokered disconnected card suppresses the legacy connect action (view_permissions only)', async (t) => {
  await withComposioEnabled({}, async () => {
    resetOauthStore();
    // No connected_accounts rows and no oauth_connections rows anywhere: every
    // integration platform resolves to the consolidated disconnected shape.
    t.mock.method(pool, 'query', makeQueryMock({}) as typeof pool.query);

    const page = (await buildIntegrationsPageDataAsync('15')) as {
      cards: Array<{ platform: string; connection_state: string; available_actions: string[] }>;
    };

    for (const platform of ['facebook', 'linkedin', 'x', 'reddit']) {
      const card = page.cards.find((c) => c.platform === platform);
      assert.equal(card?.connection_state, 'not_connected', `${platform} should be not_connected`);
      assert.deepEqual(
        card?.available_actions,
        ['view_permissions'],
        `${platform} disconnected Composio card must not offer the legacy 'connect'`,
      );
      assert.ok(
        !card?.available_actions.includes('connect'),
        `${platform} must not route the legacy broker connect`,
      );
    }
  });
});
