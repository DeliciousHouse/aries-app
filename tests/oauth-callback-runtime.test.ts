import assert from 'node:assert/strict';
import test from 'node:test';

import { oauthCallback } from '../backend/integrations/callback';
import { decryptToken } from '../backend/integrations/oauth-crypto';
import pool from '../lib/db';
import type { ProviderKey } from '../backend/integrations/provider-registry';

const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');

const OAUTH_ENV_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_AD_ACCOUNT_ID',
  'META_ACCESS_TOKEN',
  'META_PAGE_ID',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'REDDIT_USER_AGENT',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
] as const;

type PendingStateRow = {
  state: string;
  tenant_id: string;
  provider: ProviderKey;
  redirect_uri: string;
  scopes: string[];
  connection_id: string | null;
  code_verifier: string | null;
  expires_at: string;
  created_at: string;
};

type ConnectionRow = {
  id: string;
  tenant_id: string;
  provider: ProviderKey;
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

function withEnv(
  values: Partial<Record<(typeof OAUTH_ENV_KEYS)[number], string>>,
  fn: () => Promise<void>
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

function createDbHarness() {
  const pendingStates = new Map<string, PendingStateRow>();
  const connections = new Map<string, ConnectionRow>();
  const tokens: Array<{
    id: string;
    connection_id: string;
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    token_type: string | null;
    scope: string | null;
    expires_at: string | null;
    refresh_expires_at: string | null;
    issued_at: string | null;
  }> = [];
  const audits: Array<{ eventType: string; detail: string }> = [];
  let nextConnectionId = 100;
  let nextTokenId = 500;

  async function query(sql: string, params: unknown[] = []) {
    const text = String(sql);

    if (text.includes('FROM oauth_pending_states')) {
      const row = pendingStates.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (text.includes('DELETE FROM oauth_pending_states')) {
      pendingStates.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('INSERT INTO oauth_connections')) {
      const now = new Date().toISOString();
      const tenantId = String(params[0]);
      const provider = String(params[1]) as ProviderKey;
      const existing = [...connections.values()].find(
        (row) => row.tenant_id === tenantId && row.provider === provider,
      );
      const id = existing?.id || String(nextConnectionId++);
      const row: ConnectionRow = {
        id,
        tenant_id: tenantId,
        provider,
        status: String(params[2]),
        granted_scopes: (params[3] as string[]) || [],
        token_expires_at: (params[4] as string | null) ?? null,
        refresh_expires_at: (params[5] as string | null) ?? null,
        connected_at: (params[6] as string | null) ?? null,
        disconnected_at: (params[7] as string | null) ?? null,
        external_account_id: (params[8] as string | null) ?? null,
        external_account_name: (params[9] as string | null) ?? null,
        last_error_code: (params[10] as string | null) ?? null,
        last_error_message: (params[11] as string | null) ?? null,
        created_at: existing?.created_at || now,
        updated_at: now,
      };
      connections.set(id, row);
      return { rows: [row], rowCount: 1 };
    }

    if (text.includes('INSERT INTO oauth_tokens')) {
      const id = String(nextTokenId++);
      tokens.push({
        id,
        connection_id: String(params[0]),
        access_token_enc: (params[1] as string | null) ?? null,
        refresh_token_enc: (params[2] as string | null) ?? null,
        token_type: (params[3] as string | null) ?? null,
        scope: (params[4] as string | null) ?? null,
        expires_at: (params[5] as string | null) ?? null,
        refresh_expires_at: (params[6] as string | null) ?? null,
        issued_at: (params[7] as string | null) ?? null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    if (text.includes('INSERT INTO oauth_audit_events')) {
      audits.push({
        eventType: String(params[3]),
        detail: String(params[5]),
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in test harness: ${text}`);
  }

  return { pendingStates, connections, tokens, audits, query };
}

const providerCases: Array<{
  provider: ProviderKey;
  env: Partial<Record<(typeof OAUTH_ENV_KEYS)[number], string>>;
  scopes: string[];
  fetchImpl: (url: string) => Response;
  expectedAccessToken: string;
  expectedRefreshToken?: string;
  expectedExternalAccountId: string;
  expectedExternalAccountName?: string;
}> = [
  {
    provider: 'facebook',
    env: {
      META_APP_ID: 'meta-app-id',
      META_APP_SECRET: 'meta-app-secret',
      OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
    },
    scopes: ['pages_manage_posts'],
    fetchImpl(url) {
      if (url.includes('/oauth/access_token')) {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get('client_id'), 'meta-app-id');
        assert.equal(parsed.searchParams.get('client_secret'), 'meta-app-secret');
        return Response.json({
          access_token: 'facebook-access-token',
          token_type: 'bearer',
          expires_in: 3600,
        });
      }
      if (url.includes('/me?fields=id,name')) {
        return Response.json({ id: 'fb-page-123', name: 'Meta Test Page' });
      }
      throw new Error(`Unexpected fetch URL for facebook test: ${url}`);
    },
    expectedAccessToken: 'facebook-access-token',
    expectedExternalAccountId: 'fb-page-123',
    expectedExternalAccountName: 'Meta Test Page',
  },
  {
    provider: 'reddit',
    env: {
      REDDIT_CLIENT_ID: 'reddit-client-id',
      REDDIT_CLIENT_SECRET: 'reddit-client-secret',
      REDDIT_USER_AGENT: 'AriesOAuthBroker/1.0',
      OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
    },
    scopes: ['submit'],
    fetchImpl(url) {
      if (url.includes('reddit.com/api/v1/access_token')) {
        return Response.json({
          access_token: 'reddit-access-token',
          refresh_token: 'reddit-refresh-token',
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'submit',
        });
      }
      if (url.includes('oauth.reddit.com/api/v1/me')) {
        return Response.json({ id: 't2_reddit_user', name: 'reddit_user' });
      }
      throw new Error(`Unexpected fetch URL for reddit test: ${url}`);
    },
    expectedAccessToken: 'reddit-access-token',
    expectedRefreshToken: 'reddit-refresh-token',
    expectedExternalAccountId: 't2_reddit_user',
    expectedExternalAccountName: 'reddit_user',
  },
  {
    provider: 'tiktok',
    env: {
      TIKTOK_CLIENT_KEY: 'tiktok-client-key',
      TIKTOK_CLIENT_SECRET: 'tiktok-client-secret',
      OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
    },
    scopes: ['video.publish'],
    fetchImpl(url) {
      if (url.includes('open.tiktokapis.com/v2/oauth/token/')) {
        return Response.json({
          access_token: 'tiktok-access-token',
          refresh_token: 'tiktok-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_expires_in: 86400,
          scope: 'video.publish',
          open_id: 'open-id-123',
        });
      }
      throw new Error(`Unexpected fetch URL for tiktok test: ${url}`);
    },
    expectedAccessToken: 'tiktok-access-token',
    expectedRefreshToken: 'tiktok-refresh-token',
    expectedExternalAccountId: 'open-id-123',
  },
  {
    provider: 'youtube',
    env: {
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
    },
    scopes: ['https://www.googleapis.com/auth/youtube.upload'],
    fetchImpl(url) {
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({
          access_token: 'youtube-access-token',
          refresh_token: 'youtube-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/youtube.upload',
        });
      }
      if (url.includes('www.googleapis.com/youtube/v3/channels')) {
        return Response.json({
          items: [{ id: 'yt-channel-123', snippet: { title: 'YouTube Test Channel' } }],
        });
      }
      throw new Error(`Unexpected fetch URL for youtube test: ${url}`);
    },
    expectedAccessToken: 'youtube-access-token',
    expectedRefreshToken: 'youtube-refresh-token',
    expectedExternalAccountId: 'yt-channel-123',
    expectedExternalAccountName: 'YouTube Test Channel',
  },
];

for (const providerCase of providerCases) {
  test(`${providerCase.provider} callback persists token rows and connects the provider`, async (t) => {
    await withEnv(providerCase.env, async () => {
      const db = createDbHarness();
      db.pendingStates.set('state_valid_12345', {
        state: 'state_valid_12345',
        tenant_id: '123',
        provider: providerCase.provider,
        redirect_uri: `https://aries.example.com/api/auth/oauth/${providerCase.provider}/callback`,
        scopes: providerCase.scopes,
        connection_id: null,
        code_verifier: null,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        created_at: new Date().toISOString(),
      });

      t.mock.method(pool, 'query', db.query as typeof pool.query);
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        return providerCase.fetchImpl(url);
      });

      const result = await oauthCallback(providerCase.provider, {
        code: 'provider-auth-code',
        state: 'state_valid_12345',
      });

      assert.equal(result.broker_status, 'ok');
      assert.equal(result.connection_status, 'connected');
      assert.equal(db.connections.size, 1);
      assert.equal(db.tokens.length, 1);

      const [connection] = [...db.connections.values()];
      assert.equal(connection.provider, providerCase.provider);
      assert.equal(connection.status, 'connected');
      assert.equal(connection.external_account_id, providerCase.expectedExternalAccountId);
      assert.equal(connection.external_account_name ?? undefined, providerCase.expectedExternalAccountName);

      const token = db.tokens[0];
      assert.equal(decryptToken(token.access_token_enc || ''), providerCase.expectedAccessToken);
      assert.equal(
        token.refresh_token_enc ? decryptToken(token.refresh_token_enc) : undefined,
        providerCase.expectedRefreshToken,
      );
      assert.equal(db.audits.at(-1)?.eventType, 'oauth.callback.connected');
    });
  });
}

test('instagram callback is unavailable even when Meta env values are present', async (t) => {
  await withEnv(
    {
      META_PAGE_ID: 'meta-page-id',
      META_ACCESS_TOKEN: 'meta-access-token',
      OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
    },
    async () => {
      const db = createDbHarness();
      db.pendingStates.set('state_valid_12345', {
        state: 'state_valid_12345',
        tenant_id: '123',
        provider: 'instagram',
        redirect_uri: 'https://aries.example.com/api/auth/oauth/instagram/callback',
        scopes: ['instagram_content_publish'],
        connection_id: null,
        code_verifier: null,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        created_at: new Date().toISOString(),
      });

      t.mock.method(pool, 'query', db.query as typeof pool.query);
      t.mock.method(globalThis, 'fetch', async () => {
          throw new Error('fetch should not be called for Meta OAuth callbacks');
      });

      const result = await oauthCallback('instagram', {
        code: 'provider-auth-code',
        state: 'state_valid_12345',
      });

      assert.equal(result.broker_status, 'error');
      assert.equal(result.reason, 'provider_unavailable');
      assert.match(result.message || '', /configured outside Aries OAuth/i);
      assert.equal(db.connections.size, 0);
      assert.equal(db.tokens.length, 0);
    },
  );
});

test('facebook callback requires META_APP_ID for OAuth', async (t) => {
  await withEnv(
    {
      META_APP_SECRET: 'meta-app-secret',
      OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
    },
    async () => {
      const db = createDbHarness();
      db.pendingStates.set('state_valid_67890', {
        state: 'state_valid_67890',
        tenant_id: '123',
        provider: 'facebook',
        redirect_uri: 'https://aries.example.com/api/auth/oauth/facebook/callback',
        scopes: ['pages_manage_posts'],
        connection_id: null,
        code_verifier: null,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        created_at: new Date().toISOString(),
      });

      t.mock.method(pool, 'query', db.query as typeof pool.query);
      t.mock.method(globalThis, 'fetch', async () => {
        throw new Error('fetch should not be called without Facebook OAuth credentials');
      });

      const result = await oauthCallback('facebook', {
        code: 'provider-auth-code',
        state: 'state_valid_67890',
      });

      assert.equal(result.broker_status, 'error');
      assert.equal(result.reason, 'provider_unavailable');
      assert.match(result.message || '', /META_APP_ID/);
      assert.equal(db.connections.size, 0);
      assert.equal(db.tokens.length, 0);
    },
  );
});
