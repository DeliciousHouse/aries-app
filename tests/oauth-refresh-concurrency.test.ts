import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import pool from '../lib/db';
import { encryptToken } from '../backend/integrations/oauth-crypto';
import { oauthRefresh } from '../backend/integrations/refresh';

const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');

const OAUTH_ENV_KEYS = ['META_APP_ID', 'META_APP_SECRET', 'OAUTH_TOKEN_ENCRYPTION_KEY'] as const;

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

class SerialLock {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }
}

function createConcurrentDbHarness(seed: { connection: ConnectionRow; token: TokenRow }) {
  const connections = new Map<string, ConnectionRow>();
  connections.set(seed.connection.id, seed.connection);
  const tokens: TokenRow[] = [seed.token];
  const audits: Array<{ eventType: string; eventStatus: string; detail: string }> = [];
  const rowLock = new SerialLock();
  let nextTokenId = Number.parseInt(seed.token.id, 10) + 1;

  function makeClient() {
    let lockHeld = false;

    async function query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
      const text = String(sql);
      const trimmed = text.trim();

      if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        if (trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
          if (lockHeld) {
            lockHeld = false;
            rowLock.release();
          }
        }
        return { rows: [], rowCount: 0 };
      }

      if (text.includes('FROM oauth_connections') && text.includes('FOR UPDATE')) {
        await rowLock.acquire();
        lockHeld = true;
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
          const segments = setClause.split(',').map((s) => s.trim());
          for (let i = 0; i < segments.length; i += 1) {
            const segment = segments[i];
            if (segment.startsWith('status')) conn.status = String(params[i]);
            if (segment.startsWith('token_expires_at')) {
              conn.token_expires_at = (params[i] as string | null) ?? null;
            }
            if (segment.startsWith('last_error_code')) {
              conn.last_error_code = (params[i] as string | null) ?? null;
            }
            if (segment.startsWith('last_error_message')) {
              conn.last_error_message = (params[i] as string | null) ?? null;
            }
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

      throw new Error(`Unhandled SQL in concurrency harness: ${text}`);
    }

    function release(): void {
      if (lockHeld) {
        lockHeld = false;
        rowLock.release();
      }
    }

    return { query, release };
  }

  function poolQueryHandler(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const text = String(sql);
    if (text.includes('FROM oauth_connections') && text.includes('WHERE tenant_id') && text.includes('provider')) {
      const tenantId = String(params[0]);
      const provider = String(params[1]);
      const row = [...connections.values()].find(
        (c) => c.tenant_id === tenantId && c.provider === provider,
      );
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes('INSERT INTO oauth_audit_events')) {
      audits.push({
        eventType: String(params[3]),
        eventStatus: String(params[4]),
        detail: String(params[5]),
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected pool.query SQL: ${text}`);
  }

  function install(t: TestContext): void {
    t.mock.method(pool, 'connect', async () => makeClient() as unknown as Awaited<ReturnType<typeof pool.connect>>);
    t.mock.method(
      pool,
      'query',
      (async (sql: string, params?: unknown[]) => poolQueryHandler(String(sql), params ?? [])) as typeof pool.query,
    );
  }

  return { connections, tokens, audits, install };
}

function seedConnectedFacebook(): { connection: ConnectionRow; token: TokenRow } {
  const now = new Date().toISOString();
  const connection: ConnectionRow = {
    id: '42',
    tenant_id: '7',
    provider: 'facebook',
    status: 'connected',
    granted_scopes: ['pages_manage_posts'],
    token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    refresh_expires_at: null,
    connected_at: now,
    disconnected_at: null,
    external_account_id: 'fb-page-1',
    external_account_name: 'Test Page',
    last_error_code: null,
    last_error_message: null,
    created_at: now,
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
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    rotated_from_token_id: null,
    revoked_at: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
  };
  return { connection, token };
}

test('Concurrent oauthRefresh of the same connection: only one new token row is created', async (t) => {
  await withEnv(
    {
      META_APP_ID: 'meta-app-id',
      META_APP_SECRET: 'meta-app-secret',
      OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
    },
    async () => {
      const seed = seedConnectedFacebook();
      const db = createConcurrentDbHarness(seed);
      db.install(t);

      let fetchCount = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        fetchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const SIXTY_DAYS_SECONDS = 60 * 24 * 60 * 60;
        return Response.json({
          access_token: `long-lived-fb-token-${fetchCount}`,
          token_type: 'bearer',
          expires_in: SIXTY_DAYS_SECONDS,
        });
      });

      const PARALLEL = 5;
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () => oauthRefresh('facebook', '7')),
      );

      for (const result of results) {
        assert.equal(result.broker_status, 'ok');
      }

      assert.equal(fetchCount, 1, 'expected exactly one provider fetch under concurrent refresh');
      assert.equal(db.tokens.length, 2, 'expected exactly one new token row added');
      const newTokens = db.tokens.filter((tok) => tok.id !== '500');
      assert.equal(newTokens.length, 1);
      assert.equal(newTokens[0].rotated_from_token_id, '500');
    },
  );
});
