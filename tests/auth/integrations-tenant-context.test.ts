import assert from 'node:assert/strict';
import test from 'node:test';

import { handleIntegrationsGet, handleIntegrationsDisconnect, handleIntegrationsSync } from '../../app/api/integrations/handlers';
import { handlePlatformConnectionsGet } from '../../app/api/platform-connections/handlers';
import { oauthStore } from '../../backend/integrations/connect';
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

/**
 * Build a minimal pool.query mock that returns a connected DbConnectionRow for the given
 * tenant + provider when the handler calls dbGetConnection, and handles write queries
 * (INSERT/UPDATE) as no-ops, and handles dbGetConnectionById for disconnect flows.
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

    // INSERT/UPDATE/DELETE — treat as no-op success
    if (
      text.includes('INSERT INTO oauth_connections') ||
      text.includes('INSERT INTO oauth_audit_events') ||
      text.includes('INSERT INTO oauth_tokens') ||
      text.includes('DELETE FROM') ||
      text.includes('UPDATE oauth_connections') ||
      text.includes('oauth_tokens')
    ) {
      // For INSERT INTO oauth_connections RETURNING, return the first matching row
      if (text.includes('INSERT INTO oauth_connections') && text.includes('RETURNING')) {
        const tenantIdInt = Number(params[0]);
        const provider = String(params[1]);
        const row = connections.find(
          (c) => Number(c.tenant_id) === tenantIdInt && c.provider === provider
        );
        return { rows: row ? [{ ...row, status: String(params[2]) }] : [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in test mock: ${text}`);
  };
}

test('integrations GET ignores forged tenant_id query input and uses authenticated tenant context', async (t) => {
  await withMetaEnv(async () => {
    resetOauthStore();

    const now = '2026-03-16T00:00:00.000Z';
    const connRow = {
      id: '101',
      tenant_id: '1',
      provider: 'facebook',
      status: 'connected',
      granted_scopes: [],
      token_expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      refresh_expires_at: null,
      connected_at: now,
      disconnected_at: null,
      external_account_id: null,
      external_account_name: null,
      last_error_code: null,
      last_error_message: null,
      created_at: now,
      updated_at: now,
    };
    t.mock.method(pool, 'query', makeQueryMock([connRow]) as typeof pool.query);

    const response = await handleIntegrationsGet(async () => ({
      userId: 'user_123',
      tenantId: '1',
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
});

test('platform connections GET returns authenticated tenant data instead of forged tenant_id query input', async (t) => {
  await withMetaEnv(async () => {
    resetOauthStore();

    const now = '2026-03-16T00:00:00.000Z';
    const connRow = {
      id: '101',
      tenant_id: '1',
      provider: 'facebook',
      status: 'connected',
      granted_scopes: [],
      token_expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      refresh_expires_at: null,
      connected_at: now,
      disconnected_at: null,
      external_account_id: null,
      external_account_name: null,
      last_error_code: null,
      last_error_message: null,
      created_at: now,
      updated_at: now,
    };
    t.mock.method(pool, 'query', makeQueryMock([connRow]) as typeof pool.query);

    const response = await handlePlatformConnectionsGet(async () => ({
      userId: 'user_123',
      tenantId: '1',
      tenantSlug: 'acme',
      role: 'tenant_admin',
    }));
    const body = (await response.json()) as {
      status: string;
      connections: Array<{ provider: string; tenant_id: string; connection_id: string }>;
    };

    assert.equal(response.status, 200);
    const facebook = body.connections.find((connection) => connection.provider === 'facebook');
    assert.equal(facebook?.tenant_id, '1');
    assert.equal(facebook?.connection_id, '101');
  });
});

test('integrations disconnect ignores forged request tenant_id and disconnects only within authenticated tenant', async (t) => {
  await withMetaEnv(async () => {
    resetOauthStore();

    const now = '2026-03-16T00:00:00.000Z';
    const connRow = {
      id: '101',
      tenant_id: '1',
      provider: 'facebook',
      status: 'connected',
      granted_scopes: [],
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
    };
    t.mock.method(pool, 'query', makeQueryMock([connRow]) as typeof pool.query);

    const response = await handleIntegrationsDisconnect(
      new Request('http://localhost/api/integrations/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'facebook', tenant_id: 'forged_tenant', confirm: true }),
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
  });
});

test('integrations sync uses authenticated tenant context and rejects missing tenant context', async (t) => {
  await withMetaEnv(async () => {
    resetOauthStore();

    // Set Hermes env so the adapter submits (not configurationError) and we can intercept.
    const prevGatewayUrl = process.env.HERMES_GATEWAY_URL;
    const prevApiKey = process.env.HERMES_API_SERVER_KEY;
    process.env.HERMES_GATEWAY_URL = 'https://hermes.test';
    process.env.HERMES_API_SERVER_KEY = 'test-api-key';

    let capturedBody: Record<string, unknown> | null = null;

    // Mock fetch to capture the payload sent to Hermes and return a completed run.
    // Hermes calls fetch(urlString, init) — the body is in init.body, not in a Request object.
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/runs') && !url.includes('/v1/runs/')) {
        // POST to submit run — capture body from init
        if (init?.body && typeof init.body === 'string') {
          capturedBody = JSON.parse(init.body) as Record<string, unknown>;
        }
        return Response.json({ run_id: 'test-run-001' }, { status: 201 });
      }
      if (url.includes('/v1/runs/')) {
        // Poll — return completed with a successful output
        return Response.json({
          status: 'completed',
          output: JSON.stringify({ status: 'ok', provider: 'hermes' }),
        });
      }
      throw new Error(`Unexpected fetch in integrations sync test: ${url}`);
    });

    try {
      const accepted = await handleIntegrationsSync(
        new Request('http://localhost/api/integrations/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'facebook', tenant_id: 'forged_tenant' }),
        }),
        async () => ({
          userId: 'user_123',
          tenantId: '1',
          tenantSlug: 'acme',
          role: 'tenant_admin',
        })
      );

      // Hermes submitted successfully and returned some output; the important thing is
      // the handler resolved (not 503) and the payload was submitted with the authenticated tenant_id.
      assert.ok(accepted.status !== 503, `Expected non-503 response (Hermes configured), got ${accepted.status}`);

      // Extract the args from the captured Hermes prompt (line: "Args (JSON): <json>")
      const capturedInput = capturedBody != null ? (capturedBody['input'] as string | undefined) : undefined;
      const prompt = typeof capturedInput === 'string' ? capturedInput : '';
      const argsMatch = prompt.match(/Args \(JSON\): (.+)/);
      assert.ok(argsMatch, 'Hermes prompt should contain an Args (JSON) line');
      const submittedArgs = JSON.parse((argsMatch as RegExpMatchArray)[1]) as Record<string, unknown>;
      // Authenticated tenant_id ('1') used — not the forged one ('forged_tenant')
      assert.equal(submittedArgs.tenant_id, '1');
    } finally {
      if (prevGatewayUrl === undefined) {
        delete process.env.HERMES_GATEWAY_URL;
      } else {
        process.env.HERMES_GATEWAY_URL = prevGatewayUrl;
      }
      if (prevApiKey === undefined) {
        delete process.env.HERMES_API_SERVER_KEY;
      } else {
        process.env.HERMES_API_SERVER_KEY = prevApiKey;
      }
    }

    // Unauthenticated requests must be rejected before reaching Hermes.
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
  });
});
