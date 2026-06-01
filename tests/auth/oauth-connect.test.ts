import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIntegrationsConnect, handleIntegrationsDisconnect, handleOauthReconnect } from '../../app/api/integrations/handlers';
import { handleOauthCallbackHttp } from '../../backend/integrations/callback';
import { connectMeta } from '../../backend/integrations/meta/connect';
import { oauthStore } from '../../backend/integrations/connect';
import { buildOauthConnectInput } from '../../lib/oauth-connect-input';
import { verifyLogin } from '../../frontend/services/supabase';
import pool from '../../lib/db';

const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');

const META_ENV_KEYS = ['META_APP_ID', 'META_APP_SECRET', 'OAUTH_TOKEN_ENCRYPTION_KEY'] as const;

function withMetaEnv(fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of META_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }
  process.env.META_APP_ID = 'test-app-id';
  process.env.META_APP_SECRET = 'test-app-secret';
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

// TWO-STORE COLUMN CONTRACT (not a bug — do not "unify"):
//   - Live Postgres column is `status`            (backend/integrations/oauth-db.ts:10)
//   - Live in-memory store column is `connection_status` (backend/integrations/oauth-memory-store.ts:10)
// The SQL mock rows below use `status`; this in-memory seed uses `connection_status`. Each mirrors
// its own store's real shape. The post-mutation "unchanged" assertions (~:413/:506) deliberately read
// the IN-MEMORY store's `connection_status` to prove disconnect/reconnect mutated Postgres ONLY and
// left the memory store untouched. Renaming either column would break a correct test.
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

/**
 * Build a pool.query mock that services SELECT by tenant+provider, SELECT by id,
 * and treats all writes (INSERT/UPDATE/DELETE) as no-ops. Numeric tenant IDs and
 * connection IDs are required since oauth-db.ts parseInts them.
 *
 * Row shape uses `status` — the LIVE Postgres column (oauth-db.ts:10), which is
 * deliberately different from the in-memory store's `connection_status`
 * (oauth-memory-store.ts:10). See the two-store contract note on seedConnectedProvider.
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
}>) {
  return async (sql: string, params: unknown[] = []) => {
    const text = String(sql);

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

    // INSERT INTO oauth_connections RETURNING (dbUpsertConnection)
    if (text.includes('INSERT INTO oauth_connections') && text.includes('RETURNING')) {
      const tenantIdInt = Number(params[0]);
      const provider = String(params[1]);
      const status = String(params[2]);
      const row = connections.find(
        (c) => Number(c.tenant_id) === tenantIdInt && c.provider === provider
      );
      if (row) {
        return { rows: [{ ...row, status }], rowCount: 1 };
      }
      // Return a synthetic row for new connections
      const now = new Date().toISOString();
      return {
        rows: [{
          id: '999',
          tenant_id: String(tenantIdInt),
          provider,
          status,
          granted_scopes: params[3] ?? [],
          token_expires_at: null,
          refresh_expires_at: null,
          connected_at: null,
          disconnected_at: null,
          external_account_id: null,
          external_account_name: null,
          last_error_code: null,
          last_error_message: null,
          created_at: now,
          updated_at: now,
        }],
        rowCount: 1,
      };
    }

    // INSERT INTO oauth_pending_states RETURNING
    if (text.includes('INSERT INTO oauth_pending_states') && text.includes('RETURNING')) {
      const now = new Date().toISOString();
      return {
        rows: [{
          state: String(params[0]),
          tenant_id: String(params[1]),
          provider: String(params[2]),
          redirect_uri: String(params[3]),
          scopes: params[4] ?? [],
          connection_id: params[5] != null ? String(params[5]) : null,
          code_verifier: params[6] != null ? String(params[6]) : null,
          expires_at: String(params[7]),
          created_at: now,
        }],
        rowCount: 1,
      };
    }

    // SELECT FROM oauth_pending_states (dbGetPendingState)
    if (text.includes('FROM oauth_pending_states') && text.includes('WHERE state = $1')) {
      // No pending states in DB for these tests unless explicitly needed
      return { rows: [], rowCount: 0 };
    }

    // All other writes — audit events, token revocations, deletes, updates
    if (
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

test('meta connect validates redirect_uri against configured Aries callback env', async () => {
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  const previousMetaRedirectUri = process.env.META_REDIRECT_URI;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  delete process.env.META_REDIRECT_URI;

  try {
    const ok = connectMeta({
      tenant_id: 'tenant_real',
      provider: 'facebook',
      redirect_uri: 'https://aries.example.com/api/integrations/meta/callback',
    });
    assert.equal(ok.status, 'error');
    assert.equal(ok.reason, 'provider_unavailable');

    const bad = connectMeta({
      tenant_id: 'tenant_real',
      provider: 'facebook',
      redirect_uri: 'https://forged.example.com/api/integrations/meta/callback',
    });
    assert.equal(bad.status, 'error');
    assert.equal(bad.reason, 'validation_error');
  } finally {
    if (previousAppBaseUrl === undefined) {
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = previousAppBaseUrl;
    }

    if (previousMetaRedirectUri === undefined) {
      delete process.env.META_REDIRECT_URI;
    } else {
      process.env.META_REDIRECT_URI = previousMetaRedirectUri;
    }
  }
});

test('oauth connect routes ignore forged tenant_id and use authenticated tenant context', async (t) => {
  await withMetaEnv(async () => {
    // Mock pool.query so dbGetConnection + dbUpsertConnection + dbInsertPendingState + dbAuditEvent succeed
    t.mock.method(pool, 'query', makeQueryMock([]) as typeof pool.query);

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
        tenantId: '1',
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

test('oauth disconnect routes ignore forged connection_id and disconnect only the authenticated tenant provider', async (t) => {
  await withMetaEnv(async () => {
    resetOauthStore();
    // Use numeric tenant IDs ('1', '2') and numeric connection IDs ('101', '102')
    // as required by toTenantIdInt / dbGetConnectionById integer parsing
    seedConnectedProvider({
      tenantId: '1',
      provider: 'facebook',
      connectionId: '101',
      updatedAt: '2026-03-16T00:00:00.000Z',
    });
    seedConnectedProvider({
      tenantId: '2',
      provider: 'facebook',
      connectionId: '102',
      updatedAt: '2026-03-16T00:00:00.000Z',
    });

    const now = '2026-03-16T00:00:00.000Z';
    const connRows = [
      {
        id: '101',
        tenant_id: '1',
        provider: 'facebook',
        status: 'connected',
        granted_scopes: [] as string[],
        token_expires_at: null,
        refresh_expires_at: null,
        connected_at: now,
        disconnected_at: null,
        external_account_id: null,
        external_account_name: null,
        last_error_code: null,
        last_error_message: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: '102',
        tenant_id: '2',
        provider: 'facebook',
        status: 'connected',
        granted_scopes: [] as string[],
        token_expires_at: null,
        refresh_expires_at: null,
        connected_at: now,
        disconnected_at: null,
        external_account_id: null,
        external_account_name: null,
        last_error_code: null,
        last_error_message: null,
        created_at: now,
        updated_at: now,
      },
    ];
    const queryMock = t.mock.method(pool, 'query', makeQueryMock(connRows) as typeof pool.query);

    const response = await handleIntegrationsDisconnect(
      new Request('https://aries.example.com/api/auth/oauth/facebook/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'facebook', connection_id: '102', tenant_id: '2' }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: '1',
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
    assert.equal(body.connection_id, '101');
    assert.equal(body.disconnected, true);
    // Memory store for tenant '2' / conn '102' is unchanged (disconnect is DB-only now)
    assert.equal(oauthStore().connectionsById.get('102')?.connection_status, 'connected');
    // Positive DB-path pin: the disconnect mutation went through the Postgres mock (a write SQL to an
    // oauth_ table fired), proving disconnect persists to Postgres — the memory-store check above proves
    // the in-memory `connection_status` shape was NOT touched. Two stores, two columns, both correct.
    assert.ok(
      queryMock.mock.calls.some((call) =>
        /\b(UPDATE oauth_|DELETE FROM oauth_|INSERT INTO oauth_(audit_events|tokens))/.test(String(call.arguments[0])),
      ),
      'expected a Postgres write (UPDATE/DELETE/INSERT on an oauth_ table) during disconnect',
    );
  });
});

test('oauth reconnect routes ignore forged connection_id and use the authenticated tenant provider connection', async (t) => {
  await withMetaEnv(async () => {
    resetOauthStore();
    // Numeric tenant IDs and connection IDs required
    seedConnectedProvider({
      tenantId: '1',
      provider: 'facebook',
      connectionId: '101',
      updatedAt: '2026-03-16T00:00:00.000Z',
      grantedScopes: ['pages_manage_posts'],
    });
    seedConnectedProvider({
      tenantId: '2',
      provider: 'facebook',
      connectionId: '102',
      updatedAt: '2026-03-16T00:00:00.000Z',
      grantedScopes: ['pages_read_engagement'],
    });

    const now = '2026-03-16T00:00:00.000Z';
    const connRows = [
      {
        id: '101',
        tenant_id: '1',
        provider: 'facebook',
        status: 'connected',
        granted_scopes: ['pages_manage_posts'],
        token_expires_at: null,
        refresh_expires_at: null,
        connected_at: now,
        disconnected_at: null,
        external_account_id: null,
        external_account_name: null,
        last_error_code: null,
        last_error_message: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: '102',
        tenant_id: '2',
        provider: 'facebook',
        status: 'connected',
        granted_scopes: ['pages_read_engagement'],
        token_expires_at: null,
        refresh_expires_at: null,
        connected_at: now,
        disconnected_at: null,
        external_account_id: null,
        external_account_name: null,
        last_error_code: null,
        last_error_message: null,
        created_at: now,
        updated_at: now,
      },
    ];
    t.mock.method(pool, 'query', makeQueryMock(connRows) as typeof pool.query);

    const response = await handleOauthReconnect(
      new Request('https://aries.example.com/api/auth/oauth/facebook/reconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connection_id: '102',
          redirect_uri: 'https://forged.example.com/callback',
          scopes: ['pages_manage_posts'],
        }),
      }),
      'facebook',
      async () => ({
        userId: 'user_123',
        tenantId: '1',
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
    assert.equal(body.connection_id, '101');
    assert.match(body.authorization_url, /redirect_uri=https%3A%2F%2Faries\.example\.com%2Fapi%2Fauth%2Foauth%2Ffacebook%2Fcallback/);
    // Reconnect creates a pending state in DB; the memory store is not used for pending states
    assert.ok(typeof body.authorization_url === 'string' && body.authorization_url.includes('state='));
    // Memory store for tenant '2' / conn '102' is unchanged (reconnect is DB-only now)
    assert.equal(oauthStore().connectionsById.get('102')?.connection_status, 'connected');
  });
});

test('oauth reconnect routes reject requests without tenant context', async () => {
  resetOauthStore();
  const response = await handleOauthReconnect(
    new Request('https://aries.example.com/api/auth/oauth/facebook/reconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connection_id: '102' }),
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

test('oauth callback redirects browser requests to the branded OAuth screen', async (t) => {
  await withMetaEnv(async () => {
    resetOauthStore();

    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const createdAt = new Date().toISOString();
    const now = createdAt;

    // Mock pool.query: serve dbGetPendingState, then handle all writes
    t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
      const text = String(sql);

      if (text.includes('FROM oauth_pending_states') && text.includes('WHERE state = $1')) {
        if (String(params[0]) === 'state_valid123') {
          return {
            rows: [{
              state: 'state_valid123',
              tenant_id: '1',
              provider: 'facebook',
              redirect_uri: 'https://aries.example.com/api/auth/oauth/facebook/callback',
              scopes: ['pages_manage_posts'],
              connection_id: null,
              code_verifier: null,
              picker_payload: null,
              expires_at: expiresAt,
              created_at: createdAt,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // INSERT INTO oauth_connections RETURNING (after facebook callback exchange)
      if (text.includes('INSERT INTO oauth_connections') && text.includes('RETURNING')) {
        return {
          rows: [{
            id: '101',
            tenant_id: '1',
            provider: 'facebook',
            status: 'connected',
            granted_scopes: ['pages_manage_posts'],
            token_expires_at: null,
            refresh_expires_at: null,
            connected_at: now,
            disconnected_at: null,
            external_account_id: 'page-123',
            external_account_name: 'Test Page',
            last_error_code: null,
            last_error_message: null,
            created_at: now,
            updated_at: now,
          }],
          rowCount: 1,
        };
      }

      // All writes (audit events, token inserts, pending state deletes)
      if (
        text.includes('INSERT INTO oauth_audit_events') ||
        text.includes('INSERT INTO oauth_tokens') ||
        text.includes('DELETE FROM oauth_pending_states') ||
        text.includes('UPDATE oauth_pending_states')
      ) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unhandled SQL in callback test mock: ${text}`);
    }) as typeof pool.query);

    // Mock fetch for the Facebook OAuth token exchange and page discovery.
    // The Facebook flow hits:
    // 1. /oauth/access_token?code=...           → short-lived token exchange
    // 2. /oauth/access_token?grant_type=fb_exchange_token → long-lived exchange
    // 3. /me/accounts?access_token=...          → list of managed pages
    // 4. /{pageId}?fields=instagram_business_account,...  → page detail (one call per page)
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      // Parse hostname for CodeQL-safe origin check (substring match on
      // 'graph.facebook.com' would let 'graph.facebook.com.evil.com' through).
      const parsed = new URL(url);
      const isGraphFb = parsed.hostname === 'graph.facebook.com';
      // Short-lived token exchange (has `code=` param, no fb_exchange_token)
      if (isGraphFb && url.includes('oauth/access_token') && url.includes('code=')) {
        return Response.json({ access_token: 'short-lived-token', token_type: 'bearer', expires_in: 3600 });
      }
      // Long-lived token exchange (has fb_exchange_token param)
      if (isGraphFb && url.includes('oauth/access_token') && url.includes('fb_exchange_token')) {
        return Response.json({ access_token: 'long-lived-token', token_type: 'bearer', expires_in: 5183944 });
      }
      // Page list — /me/accounts
      if (isGraphFb && url.includes('/me/accounts')) {
        return Response.json({
          data: [{
            id: 'page-123',
            name: 'Test Page',
            access_token: 'page-access-token',
          }],
        });
      }
      // Page detail — /{pageId}?fields=instagram_business_account,...
      if (isGraphFb && url.includes('page-123') && url.includes('fields=')) {
        return Response.json({
          id: 'page-123',
          name: 'Test Page',
          access_token: 'long-page-access-token',
          instagram_business_account: null,
        });
      }
      throw new Error(`Unexpected fetch in callback test: ${url}`);
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
});
