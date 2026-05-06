import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import pool from '../lib/db';
import { decryptToken } from '../backend/integrations/oauth-crypto';
import { oauthCallback } from '../backend/integrations/callback';
import { handleMetaSelectPageHttp } from '../backend/integrations/meta/select-page';

const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');

const OAUTH_ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_GRAPH_API_VERSION',
  'OAUTH_TOKEN_ENCRYPTION_KEY',
  'APP_BASE_URL',
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
};

type PendingStateRow = {
  state: string;
  tenant_id: string;
  provider: string;
  redirect_uri: string;
  scopes: string[];
  connection_id: string | null;
  code_verifier: string | null;
  picker_payload: unknown | null;
  expires_at: string;
  created_at: string;
};

type DbHarness = {
  pendingStates: Map<string, PendingStateRow>;
  connections: Map<string, ConnectionRow>;
  tokens: TokenRow[];
  audits: Array<{ eventType: string; eventStatus: string; detail: string }>;
  install: (t: TestContext) => void;
};

function createDbHarness(): DbHarness {
  const pendingStates = new Map<string, PendingStateRow>();
  const connections = new Map<string, ConnectionRow>();
  const tokens: TokenRow[] = [];
  const audits: Array<{ eventType: string; eventStatus: string; detail: string }> = [];
  let nextConnectionId = 100;
  let nextTokenId = 500;

  function findConnection(tenantId: string, provider: string): ConnectionRow | undefined {
    return [...connections.values()].find((row) => row.tenant_id === tenantId && row.provider === provider);
  }

  function handleQuery(rawSql: unknown, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const text = String(rawSql);

    if (text.includes('DELETE FROM oauth_pending_states')) {
      pendingStates.delete(String(params[0]));
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('UPDATE oauth_pending_states') && text.includes('picker_payload')) {
      const stateKey = String(params[1]);
      const row = pendingStates.get(stateKey);
      if (row) {
        row.picker_payload = params[0] != null ? JSON.parse(String(params[0])) : null;
        pendingStates.set(stateKey, row);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (text.includes('FROM oauth_pending_states')) {
      const row = pendingStates.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (text.includes('INSERT INTO oauth_connections')) {
      const now = new Date().toISOString();
      const tenantId = String(params[0]);
      const provider = String(params[1]);
      const existing = findConnection(tenantId, provider);
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
        external_account_id: (params[8] as string | null) ?? existing?.external_account_id ?? null,
        external_account_name: (params[9] as string | null) ?? existing?.external_account_name ?? null,
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
        eventStatus: String(params[4]),
        detail: String(params[5]),
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in test harness: ${text}`);
  }

  function install(t: TestContext): void {
    t.mock.method(
      pool,
      'query',
      (async (sql: string, params?: unknown[]) => handleQuery(sql, params ?? [])) as typeof pool.query,
    );
  }

  return { pendingStates, connections, tokens, audits, install };
}

type FixturePage = {
  id: string;
  name: string;
  pageAccessToken: string;
  instagramBusinessAccountId?: string | null;
};

type FetchScenario = {
  shortToken: string;
  longToken: string;
  pages: FixturePage[];
  longTokenCalls: { count: number };
  meAccountsCalls: { count: number };
};

function makeMetaFetchMock(scenario: FetchScenario) {
  return async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('/oauth/access_token')) {
      const parsed = new URL(url);
      const grantType = parsed.searchParams.get('grant_type');
      if (grantType === 'fb_exchange_token') {
        scenario.longTokenCalls.count += 1;
        assert.equal(parsed.searchParams.get('fb_exchange_token'), scenario.shortToken);
        assert.equal(parsed.searchParams.get('client_id'), 'meta-app-id');
        assert.equal(parsed.searchParams.get('client_secret'), 'meta-app-secret');
        return Response.json({
          access_token: scenario.longToken,
          token_type: 'bearer',
          expires_in: 60 * 24 * 60 * 60,
        });
      }
      assert.equal(parsed.searchParams.get('client_id'), 'meta-app-id');
      assert.equal(parsed.searchParams.get('client_secret'), 'meta-app-secret');
      return Response.json({
        access_token: scenario.shortToken,
        token_type: 'bearer',
        expires_in: 3600,
      });
    }

    if (url.includes('/me/accounts')) {
      scenario.meAccountsCalls.count += 1;
      const parsed = new URL(url);
      assert.equal(
        parsed.searchParams.get('access_token'),
        scenario.longToken,
        'me/accounts must be called with the long-lived user token',
      );
      return Response.json({
        data: scenario.pages.map((page) => ({
          id: page.id,
          name: page.name,
          access_token: page.pageAccessToken,
        })),
      });
    }

    const pageMatch = url.match(/graph\.facebook\.com\/(?:v\d+\.\d+\/)?([^/?]+)\?/);
    if (pageMatch) {
      const parsed = new URL(url);
      const pageId = pageMatch[1];
      const fixturePage = scenario.pages.find((p) => p.id === pageId);
      if (fixturePage) {
        assert.equal(
          parsed.searchParams.get('access_token'),
          fixturePage.pageAccessToken,
          'page detail must be fetched with the page access token, never the user token',
        );
        const fields = parsed.searchParams.get('fields') ?? '';
        assert.match(fields, /instagram_business_account/);
        assert.match(fields, /access_token/);
        return Response.json({
          id: fixturePage.id,
          name: fixturePage.name,
          access_token: fixturePage.pageAccessToken,
          instagram_business_account: fixturePage.instagramBusinessAccountId
            ? { id: fixturePage.instagramBusinessAccountId }
            : undefined,
        });
      }
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

function seedPendingFacebook(db: DbHarness, state: string, tenantId = '7'): void {
  db.pendingStates.set(state, {
    state,
    tenant_id: tenantId,
    provider: 'facebook',
    redirect_uri: 'https://aries.example.com/api/auth/oauth/facebook/callback',
    scopes: ['pages_manage_posts', 'instagram_content_publish'],
    connection_id: null,
    code_verifier: null,
    picker_payload: null,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    created_at: new Date().toISOString(),
  });
}

const META_ENV: Partial<Record<(typeof OAUTH_ENV_KEYS)[number], string>> = {
  META_APP_ID: 'meta-app-id',
  META_APP_SECRET: 'meta-app-secret',
  OAUTH_TOKEN_ENCRYPTION_KEY: BASE64_KEY,
  APP_BASE_URL: 'https://aries.example.com',
};

test('meta callback: short→long exchange persists Page Access Token (single page with IG BA)', async (t) => {
  await withEnv(META_ENV, async () => {
    const db = createDbHarness();
    seedPendingFacebook(db, 'state_single_page');
    db.install(t);

    const scenario: FetchScenario = {
      shortToken: 'fb-short-1',
      longToken: 'fb-long-1',
      pages: [{ id: 'page_alpha', name: 'Alpha Page', pageAccessToken: 'page-token-alpha', instagramBusinessAccountId: 'ig_alpha_42' }],
      longTokenCalls: { count: 0 },
      meAccountsCalls: { count: 0 },
    };
    t.mock.method(globalThis, 'fetch', makeMetaFetchMock(scenario));

    const result = await oauthCallback('facebook', { code: 'auth-code-1', state: 'state_single_page' });

    assert.equal(scenario.longTokenCalls.count, 1, 'long-lived exchange must be invoked exactly once');
    assert.equal(scenario.meAccountsCalls.count, 1, '/me/accounts must be called exactly once');

    assert.equal(result.broker_status, 'ok');
    if (result.broker_status === 'ok') {
      assert.equal(result.provider, 'facebook');
      assert.equal(result.connection_status, 'connected');
    }

    assert.equal(db.connections.size, 2, 'must create both facebook and instagram connections');
    const facebookConn = [...db.connections.values()].find((c) => c.provider === 'facebook');
    const instagramConn = [...db.connections.values()].find((c) => c.provider === 'instagram');
    assert.ok(facebookConn);
    assert.ok(instagramConn);
    assert.equal(facebookConn.status, 'connected');
    assert.equal(instagramConn.status, 'connected');
    assert.equal(facebookConn.external_account_id, 'page_alpha');
    assert.equal(facebookConn.external_account_name, 'Alpha Page');
    assert.equal(instagramConn.external_account_id, 'ig_alpha_42');

    assert.equal(db.tokens.length, 2, 'one token row per connection');
    for (const token of db.tokens) {
      assert.equal(decryptToken(token.access_token_enc || ''), 'page-token-alpha');
      assert.notEqual(decryptToken(token.access_token_enc || ''), scenario.shortToken);
      assert.notEqual(decryptToken(token.access_token_enc || ''), scenario.longToken);
    }
    const okAudit = db.audits.find((a) => a.eventType === 'oauth.callback.connected');
    assert.ok(okAudit, 'expected oauth.callback.connected audit');

    assert.equal(db.pendingStates.size, 0, 'pending state must be deleted after success');
  });
});

test('meta callback: single page without IG BA persists Page Token, no Instagram sibling', async (t) => {
  await withEnv(META_ENV, async () => {
    const db = createDbHarness();
    seedPendingFacebook(db, 'state_no_ig');
    db.install(t);

    const scenario: FetchScenario = {
      shortToken: 'fb-short-2',
      longToken: 'fb-long-2',
      pages: [{ id: 'page_beta', name: 'Beta Page', pageAccessToken: 'page-token-beta', instagramBusinessAccountId: null }],
      longTokenCalls: { count: 0 },
      meAccountsCalls: { count: 0 },
    };
    t.mock.method(globalThis, 'fetch', makeMetaFetchMock(scenario));

    const result = await oauthCallback('facebook', { code: 'auth-code-2', state: 'state_no_ig' });

    assert.equal(result.broker_status, 'ok');
    assert.equal(db.connections.size, 1, 'no instagram sibling when page has no IG BA');
    const facebookConn = [...db.connections.values()][0];
    assert.equal(facebookConn.provider, 'facebook');
    assert.equal(facebookConn.external_account_id, 'page_beta');
    assert.equal(db.tokens.length, 1);
    assert.equal(decryptToken(db.tokens[0].access_token_enc || ''), 'page-token-beta');
  });
});

test('meta callback: zero pages marks connection error and surfaces no_pages reason', async (t) => {
  await withEnv(META_ENV, async () => {
    const db = createDbHarness();
    seedPendingFacebook(db, 'state_zero_pages');
    db.install(t);

    const scenario: FetchScenario = {
      shortToken: 'fb-short-3',
      longToken: 'fb-long-3',
      pages: [],
      longTokenCalls: { count: 0 },
      meAccountsCalls: { count: 0 },
    };
    t.mock.method(globalThis, 'fetch', makeMetaFetchMock(scenario));

    const result = await oauthCallback('facebook', { code: 'auth-code-3', state: 'state_zero_pages' });

    assert.equal(result.broker_status, 'error');
    if (result.broker_status === 'error') {
      assert.equal(result.provider, 'facebook');
      assert.match(result.message ?? '', /no.*pages/i);
    }
    assert.equal(db.tokens.length, 0, 'no token persisted when zero pages');
    const facebookConn = [...db.connections.values()].find((c) => c.provider === 'facebook');
    assert.ok(facebookConn);
    assert.equal(facebookConn.status, 'error');
    assert.equal(facebookConn.last_error_code, 'meta_no_pages_available');

    const errAudit = db.audits.find((a) => a.eventStatus === 'error');
    assert.ok(errAudit, 'must record error audit on zero-pages branch');
    assert.equal(db.pendingStates.size, 0, 'pending state cleaned up on terminal error');
  });
});

test('meta callback: multi-page returns picker_required and stashes pages in pending state', async (t) => {
  await withEnv(META_ENV, async () => {
    const db = createDbHarness();
    seedPendingFacebook(db, 'state_multi_page');
    db.install(t);

    const scenario: FetchScenario = {
      shortToken: 'fb-short-4',
      longToken: 'fb-long-4',
      pages: [
        { id: 'page_gamma', name: 'Gamma Page', pageAccessToken: 'page-token-gamma', instagramBusinessAccountId: 'ig_gamma_99' },
        { id: 'page_delta', name: 'Delta Page', pageAccessToken: 'page-token-delta', instagramBusinessAccountId: null },
        { id: 'page_epsilon', name: 'Epsilon Page', pageAccessToken: 'page-token-epsilon', instagramBusinessAccountId: 'ig_epsilon_55' },
      ],
      longTokenCalls: { count: 0 },
      meAccountsCalls: { count: 0 },
    };
    t.mock.method(globalThis, 'fetch', makeMetaFetchMock(scenario));

    const result = await oauthCallback('facebook', { code: 'auth-code-4', state: 'state_multi_page' });

    assert.equal(result.broker_status, 'picker_required');
    if (result.broker_status === 'picker_required') {
      assert.equal(result.provider, 'facebook');
      assert.equal(result.state, 'state_multi_page');
      assert.equal(result.pages.length, 3);
      const gamma = result.pages.find((p) => p.id === 'page_gamma');
      assert.ok(gamma);
      assert.equal(gamma.has_instagram, true);
      const delta = result.pages.find((p) => p.id === 'page_delta');
      assert.ok(delta);
      assert.equal(delta.has_instagram, false);
    }

    assert.equal(db.tokens.length, 0, 'no token persisted before page selection');
    assert.equal(db.connections.size, 0, 'no connection upserts before page selection');

    const stashed = db.pendingStates.get('state_multi_page');
    assert.ok(stashed?.picker_payload, 'pending state must carry picker payload across round-trip');
    const payload = stashed.picker_payload as { pages?: Array<{ id: string; pageAccessToken?: string; instagramBusinessAccountId?: string | null }> };
    assert.equal(payload.pages?.length, 3);
    const stashedDelta = payload.pages?.find((p) => p.id === 'page_delta');
    assert.equal(stashedDelta?.instagramBusinessAccountId, null);
  });
});

test('handleMetaSelectPageHttp: completes connection from picker selection', async (t) => {
  await withEnv(META_ENV, async () => {
    const db = createDbHarness();
    db.pendingStates.set('state_picker_done', {
      state: 'state_picker_done',
      tenant_id: '7',
      provider: 'facebook',
      redirect_uri: 'https://aries.example.com/api/auth/oauth/facebook/callback',
      scopes: ['pages_manage_posts'],
      connection_id: null,
      code_verifier: null,
      picker_payload: {
        pages: [
          { id: 'page_zeta', name: 'Zeta Page', pageAccessToken: 'page-token-zeta', instagramBusinessAccountId: 'ig_zeta_77' },
          { id: 'page_eta', name: 'Eta Page', pageAccessToken: 'page-token-eta', instagramBusinessAccountId: null },
        ],
      },
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      created_at: new Date().toISOString(),
    });
    db.install(t);

    const req = new Request('https://aries.example.com/api/oauth/meta/select-page', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'state_picker_done', page_id: 'page_zeta' }),
    });
    const res = await handleMetaSelectPageHttp(req, {
      tenantContextLoader: async () => ({
        userId: 'user-1',
        tenantId: '7',
        tenantSlug: 'test',
        role: 'tenant_admin',
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; facebook_connection_id: string; instagram_connection_id?: string | null };
    assert.equal(body.status, 'ok');
    assert.ok(body.facebook_connection_id);
    assert.ok(body.instagram_connection_id);

    const facebookConn = [...db.connections.values()].find((c) => c.provider === 'facebook');
    const instagramConn = [...db.connections.values()].find((c) => c.provider === 'instagram');
    assert.equal(facebookConn?.external_account_id, 'page_zeta');
    assert.equal(instagramConn?.external_account_id, 'ig_zeta_77');

    assert.equal(db.tokens.length, 2);
    for (const token of db.tokens) {
      assert.equal(decryptToken(token.access_token_enc || ''), 'page-token-zeta');
    }
    assert.equal(db.pendingStates.size, 0, 'pending state must be deleted after picker completes');
  });
});

test('handleMetaSelectPageHttp: rejects when tenant context does not match pending state', async (t) => {
  await withEnv(META_ENV, async () => {
    const db = createDbHarness();
    db.pendingStates.set('state_other_tenant', {
      state: 'state_other_tenant',
      tenant_id: '7',
      provider: 'facebook',
      redirect_uri: 'https://aries.example.com/api/auth/oauth/facebook/callback',
      scopes: [],
      connection_id: null,
      code_verifier: null,
      picker_payload: {
        pages: [{ id: 'page_x', name: 'X', pageAccessToken: 'tok', instagramBusinessAccountId: null }],
      },
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      created_at: new Date().toISOString(),
    });
    db.install(t);

    const req = new Request('https://aries.example.com/api/oauth/meta/select-page', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'state_other_tenant', page_id: 'page_x' }),
    });
    const res = await handleMetaSelectPageHttp(req, {
      tenantContextLoader: async () => ({
        userId: 'user-9',
        tenantId: '99',
        tenantSlug: 'other',
        role: 'tenant_admin',
      }),
    });
    assert.equal(res.status, 403);
  });
});
