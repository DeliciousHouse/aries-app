import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import pool from '../lib/db';
import { decryptToken, encryptToken } from '../backend/integrations/oauth-crypto';
import { oauthRefresh } from '../backend/integrations/refresh';

const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');

const OAUTH_ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
] as const;

function withEnv(
  values: Partial<Record<(typeof OAUTH_ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of OAUTH_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of OAUTH_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

type ConnectionRow = {
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
};

type TokenRow = {
  id: string;
  connection_id: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_type: string | null;
  scope: string | null;
  expires_at: string | null;
  refresh_expires_at: string | null;
  issued_at: string | null;
  rotated_from_token_id: string | null;
  revoked_at: string | null;
  created_at: string;
};

type DbState = {
  connections: Map<string, ConnectionRow>;
  tokens: TokenRow[];
  audits: Array<{ eventType: string; eventStatus: string; detail: string }>;
};

function createDbHarness(seed: { connection: ConnectionRow; token: TokenRow }): DbState & {
  install: (t: TestContext) => void;
} {
  const connections = new Map<string, ConnectionRow>();
  connections.set(seed.connection.id, seed.connection);
  const tokens: TokenRow[] = [seed.token];
  const audits: Array<{ eventType: string; eventStatus: string; detail: string }> = [];
  let nextTokenId = Number.parseInt(seed.token.id, 10) + 1;

  function handleQuery(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const text = sql;

    if (text.trim() === 'BEGIN' || text.trim() === 'COMMIT' || text.trim() === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (text.includes('FROM oauth_connections') && text.includes('FOR UPDATE')) {
      const idStr = String(params[0]);
      const row = [...connections.values()].find((c) => c.id === idStr);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (text.includes('FROM oauth_connections') && text.includes('WHERE tenant_id') && text.includes('provider')) {
      const tenantId = String(params[0]);
      const provider = String(params[1]);
      const row = [...connections.values()].find((c) => c.tenant_id === tenantId && c.provider === provider);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (text.includes('FROM oauth_tokens') && text.includes('ORDER BY created_at DESC')) {
      const connectionId = String(params[0]);
      const filtered = tokens
        .filter((t) => t.connection_id === connectionId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const latest = filtered[0];
      return { rows: latest ? [latest] : [], rowCount: latest ? 1 : 0 };
    }

    if (text.includes('INSERT INTO oauth_tokens')) {
      const id = String(nextTokenId++);
      const row: TokenRow = {
        id,
        connection_id: String(params[0]),
        access_token_enc: (params[1] as string | null) ?? null,
        refresh_token_enc: (params[2] as string | null) ?? null,
        token_type: (params[3] as string | null) ?? null,
        scope: (params[4] as string | null) ?? null,
        expires_at: (params[5] as string | null) ?? null,
        refresh_expires_at: (params[6] as string | null) ?? null,
        issued_at: (params[7] as string | null) ?? null,
        rotated_from_token_id: params[8] != null ? String(params[8]) : null,
        revoked_at: null,
        created_at: new Date().toISOString(),
      };
      tokens.push(row);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (text.includes('UPDATE oauth_tokens') && text.includes('revoked_at')) {
      const tokenId = String(params[0]);
      const t = tokens.find((row) => row.id === tokenId);
      if (t && !t.revoked_at) {
        t.revoked_at = new Date().toISOString();
      }
      return { rows: [], rowCount: t ? 1 : 0 };
    }

    if (text.includes('UPDATE oauth_connections')) {
      const connectionId = String(params[params.length - 1]);
      const conn = connections.get(connectionId);
      if (conn) {
        const setClause = text.split('SET')[1]?.split('WHERE')[0] ?? '';
        if (setClause.includes('status')) {
          const idx = setClause.split(',').findIndex((c) => c.includes('status'));
          if (idx >= 0) conn.status = String(params[idx]);
        }
        if (setClause.includes('token_expires_at')) {
          const segments = setClause.split(',').map((s) => s.trim());
          const tokenExpiresIdx = segments.findIndex((s) => s.startsWith('token_expires_at'));
          if (tokenExpiresIdx >= 0) {
            conn.token_expires_at = (params[tokenExpiresIdx] as string | null) ?? null;
          }
        }
        if (setClause.includes('last_error_code')) {
          const segments = setClause.split(',').map((s) => s.trim());
          const codeIdx = segments.findIndex((s) => s.startsWith('last_error_code'));
          const msgIdx = segments.findIndex((s) => s.startsWith('last_error_message'));
          if (codeIdx >= 0) conn.last_error_code = (params[codeIdx] as string | null) ?? null;
          if (msgIdx >= 0) conn.last_error_message = (params[msgIdx] as string | null) ?? null;
        }
        connections.set(connectionId, conn);
      }
      return { rows: [], rowCount: conn ? 1 : 0 };
    }

    if (text.includes('INSERT INTO oauth_audit_events')) {
      audits.push({
        eventType: String(params[3]),
        eventStatus: String(params[4]),
        detail: String(params[5]),
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in test harness: ${text}`);
  }

  function install(t: TestContext): void {
    const fakeClient = {
      query: async (sql: string, params?: unknown[]) => handleQuery(String(sql), params ?? []),
      release: () => {},
    };
    t.mock.method(pool, 'connect', async () => fakeClient as unknown as Awaited<ReturnType<typeof pool.connect>>);
    t.mock.method(
      pool,
      'query',
      (async (sql: string, params?: unknown[]) => handleQuery(String(sql), params ?? [])) as typeof pool.query,
    );
  }

  return { connections, tokens, audits, install };
}

function seedConnectedFacebook(): { connection: ConnectionRow; token: TokenRow } {
  const now = new Date().toISOString();
  const oldIssuedAt = new Date(Date.now() - 60_000).toISOString();
  const connection: ConnectionRow = {
    id: '42',
    tenant_id: '7',
    provider: 'facebook',
    status: 'connected',
    granted_scopes: ['pages_manage_posts'],
    token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    refresh_expires_at: null,
    connected_at: oldIssuedAt,
    disconnected_at: null,
    external_account_id: 'fb-page-1',
    external_account_name: 'Test Page',
    last_error_code: null,
    last_error_message: null,
    created_at: oldIssuedAt,
    updated_at: now,
  };
  const token: TokenRow = {
    id: '500',
    connection_id: '42',
    access_token_enc: encryptToken('short-lived-fb-token'),
    refresh_token_enc: null,
    token_type: 'bearer',
    scope: 'pages_manage_posts',
    expires_at: connection.token_expires_at,
    refresh_expires_at: null,
    issued_at: oldIssuedAt,
    rotated_from_token_id: null,
    revoked_at: null,
    created_at: oldIssuedAt,
  };
  return { connection, token };
}

test('Meta refresh: long-lived exchange persists new token row and revokes old', async (t) => {
  await withEnv(
    {
      META_APP_ID: 'meta-app-id',
      META_APP_SECRET: 'meta-app-secret',
      OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
    },
    async () => {
      const seed = seedConnectedFacebook();
      const db = createDbHarness(seed);
      db.install(t);

      let fetchCount = 0;
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const parsed = new URL(url);
        if (parsed.hostname === 'graph.facebook.com' && url.includes('/oauth/access_token')) {
          fetchCount += 1;
          assert.equal(parsed.searchParams.get('grant_type'), 'fb_exchange_token');
          assert.equal(parsed.searchParams.get('client_id'), 'meta-app-id');
          assert.equal(parsed.searchParams.get('client_secret'), 'meta-app-secret');
          assert.equal(parsed.searchParams.get('fb_exchange_token'), 'short-lived-fb-token');
          const SIXTY_DAYS_SECONDS = 60 * 24 * 60 * 60;
          return Response.json({
            access_token: 'long-lived-fb-token',
            token_type: 'bearer',
            expires_in: SIXTY_DAYS_SECONDS,
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      const result = await oauthRefresh('facebook', '7');

      assert.equal(result.broker_status, 'ok');
      if (result.broker_status === 'ok') {
        assert.equal(result.provider, 'facebook');
        assert.equal(result.connection_id, '42');
        assert.equal(result.connection_status, 'connected');
        assert.ok(result.refreshed_at);
      }

      assert.equal(fetchCount, 1);
      assert.equal(db.tokens.length, 2, 'expected 2 token rows (old + new)');
      const newToken = db.tokens[db.tokens.length - 1];
      assert.equal(newToken.connection_id, '42');
      assert.equal(decryptToken(newToken.access_token_enc || ''), 'long-lived-fb-token');
      assert.equal(newToken.rotated_from_token_id, '500');
      const oldToken = db.tokens.find((row) => row.id === '500');
      assert.ok(oldToken?.revoked_at, 'old token should be revoked');

      const okAudit = db.audits.find((a) => a.eventType === 'oauth.refresh.completed');
      assert.ok(okAudit, 'should have refresh.completed audit event');
      assert.equal(okAudit?.eventStatus, 'ok');
    },
  );
});

test('Meta refresh: 401 from provider marks connection reauthorization_required', async (t) => {
  await withEnv(
    {
      META_APP_ID: 'meta-app-id',
      META_APP_SECRET: 'meta-app-secret',
      OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
    },
    async () => {
      const seed = seedConnectedFacebook();
      const db = createDbHarness(seed);
      db.install(t);

      t.mock.method(globalThis, 'fetch', async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Error validating access token: Session has expired',
              type: 'OAuthException',
              code: 190,
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      });

      const result = await oauthRefresh('facebook', '7');

      assert.equal(result.broker_status, 'error');
      if (result.broker_status === 'error') {
        assert.equal(result.provider, 'facebook');
      }

      const conn = db.connections.get('42');
      assert.equal(conn?.status, 'reauthorization_required');
      assert.ok(conn?.last_error_code);

      const errAudit = db.audits.find((a) => a.eventType === 'oauth.refresh.failed');
      assert.ok(errAudit, 'should have refresh.failed audit event');
      assert.equal(errAudit?.eventStatus, 'error');

      assert.equal(db.tokens.length, 1, 'no new token row should be inserted on 401');
    },
  );
});

test('Meta refresh: 5xx from provider does not change connection status', async (t) => {
  await withEnv(
    {
      META_APP_ID: 'meta-app-id',
      META_APP_SECRET: 'meta-app-secret',
      OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
    },
    async () => {
      const seed = seedConnectedFacebook();
      const db = createDbHarness(seed);
      db.install(t);

      t.mock.method(globalThis, 'fetch', async () => {
        return new Response('{"error":"upstream"}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      });

      const result = await oauthRefresh('facebook', '7');

      assert.equal(result.broker_status, 'error');

      const conn = db.connections.get('42');
      assert.equal(conn?.status, 'connected', '5xx is transient; status should remain connected');

      assert.equal(db.tokens.length, 1, 'no new token row should be inserted on 5xx');
    },
  );
});
