import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../lib/db';
import { encryptToken } from '../backend/integrations/oauth-crypto';
import { buildProviderAuthorizationUrl } from '../backend/integrations/oauth-authorize-urls';
import { PROVIDER_REGISTRY } from '../backend/integrations/provider-registry';
import { handleMetaAds } from '../backend/integrations/meta/ads';
import { oauthCallback } from '../backend/integrations/callback';
import { handleIntegrationsConnect } from '../app/api/integrations/handlers';

const loader = async () => ({ tenantId: '75', tenantSlug: 'test', userId: '1', role: 'tenant_admin' as const });

function setup(t: any, selected: string | null = null) {
  for (const [key, value] of Object.entries({ META_APP_ID: 'test-app', META_APP_SECRET: 'test-secret', OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const queries: { sql: string; params: any[] }[] = [];
  t.mock.method(pool, 'query', async (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('UPDATE oauth_connections')) return { rows: [{ id: '19' }], rowCount: 1 };
    if (sql.includes('FROM oauth_connections')) return { rows: [{ id: '19', tenant_id: '75', provider: 'meta_ads', status: 'connected', external_account_id: selected, granted_scopes: ['ads_read', 'ads_management'] }], rowCount: 1 };
    if (sql.includes('FROM oauth_tokens')) return { rows: [{ id: '20', connection_id: '19', access_token_enc: encryptToken('test-token'), revoked_at: null, expires_at: new Date(Date.now() + 3600000).toISOString() }], rowCount: 1 };
    throw new Error('Unexpected SQL');
  });
  return queries;
}

test('Meta Ads requests its own ad scopes without organic Page scopes', t => {
  setup(t);
  const url = buildProviderAuthorizationUrl({ provider: 'meta_ads', redirectUri: 'https://aries.example.com/api/auth/oauth/meta_ads/callback', state: 'state-test', scopes: PROVIDER_REGISTRY.meta_ads.default_scopes });
  assert.equal(url.hostname, 'www.facebook.com');
  assert.deepEqual(url.searchParams.get('scope')?.split(','), ['ads_read', 'ads_management']);
  assert.equal(PROVIDER_REGISTRY.facebook.default_scopes.includes('ads_management'), false);
});

test('account selection is tenant scoped and verifies membership, not a supplied name', async t => {
  const queries = setup(t);
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    assert.equal(url.hostname, 'graph.facebook.com');
    assert.equal(url.pathname.endsWith('/me/adaccounts'), true);
    assert.equal(options.method, 'GET');
    assert.equal(url.searchParams.has('access_token'), false);
    return Response.json({ data: [{ id: 'act_123', name: 'Verified account', currency: 'USD' }] });
  });
  const response = await handleMetaAds(new Request('https://aries.example.com/api/integrations/meta-ads', { method: 'POST', body: JSON.stringify({ accountId: 'act_123', connectionId: '19', name: 'Untrusted' }) }), loader);
  assert.equal(response.status, 200);
  const update = queries.find(q => q.sql.includes('UPDATE oauth_connections'))!;
  assert.deepEqual(update.params, ['75', '19', 'act_123', 'Verified account', '20']);
  assert.match(update.sql, /provider = 'meta_ads'/);
  assert.match(update.sql, /status = 'connected'/);
});

test('connect authenticates the tenant, persists a separate pending grant and requests only ad scopes', async t => {
  setup(t);
  const queries: { sql: string; params: any[] }[] = [];
  t.mock.method(pool, 'query', async (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    return { rows: [{ id: '19', status: 'pending' }], rowCount: 1 };
  });
  const response = await handleIntegrationsConnect(new Request('https://aries.example.com/api/auth/oauth/meta_ads/connect', {
    method: 'POST', body: JSON.stringify({ tenant_id: '999' }),
  }), 'meta_ads', loader);
  assert.equal(response.status, 200);
  const body = await response.json();
  const url = new URL(body.authorization_url);
  assert.deepEqual(url.searchParams.get('scope')?.split(','), ['ads_read', 'ads_management']);
  assert.ok(url.searchParams.get('state'));
  const pending = queries.find(query => query.sql.includes('INSERT INTO oauth_pending_states'))!;
  assert.equal(pending.params[1], 75);
  assert.equal(pending.params[2], 'meta_ads');
  assert.match(pending.params[3], /\/api\/auth\/oauth\/meta_ads\/callback$/);
  assert.equal(queries.some(query => query.params.includes('facebook')), false);
});

test('foreign account or stale connection cannot be selected', async t => {
  const queries = setup(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'act_123', name: 'Available' }] }));
  for (const body of [{ accountId: 'act_999', connectionId: '19' }, { accountId: 'act_123', connectionId: '18' }]) {
    const response = await handleMetaAds(new Request('https://aries.example.com/api/integrations/meta-ads', { method: 'POST', body: JSON.stringify(body) }), loader);
    assert.equal(response.status, 409);
  }
  assert.equal(queries.some(q => q.sql.includes('UPDATE oauth_connections')), false);
});

test('read campaigns and spend only for the selected account, with pagination', async t => {
  setup(t, 'act_123');
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    paths.push(url.pathname);
    assert.equal(options.method, 'GET');
    if (url.pathname.endsWith('/campaigns')) return Response.json({ data: [{ id: '1', name: 'Spring', status: 'PAUSED' }] });
    if (url.pathname.endsWith('/insights')) return Response.json({ data: [{ campaign_id: '1', spend: '12.50', impressions: '100', clicks: '3', date_start: '2026-10-01', date_stop: '2026-10-06' }] });
    if (!url.searchParams.has('after')) return Response.json({ data: [{ id: 'act_123', name: 'Available', currency: 'USD' }], paging: { next: 'https://untrusted.example', cursors: { after: 'next' } } });
    return Response.json({ data: [] });
  });
  const response = await handleMetaAds(new Request('https://aries.example.com/api/integrations/meta-ads?performance=1&period=7day'), loader);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.currency, 'USD');
  assert.equal(body.campaigns[0].spend, 12.5);
  assert.equal(body.campaigns[0].status, 'PAUSED');
  assert.equal(paths.filter(p => p.endsWith('/me/adaccounts')).length, 2);
});

test('lost access to the selected account never reads its campaigns or substitutes a different account', async t => {
  setup(t, 'act_999');
  const calls = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'act_123', name: 'Available' }] }));
  const response = await handleMetaAds(new Request('https://aries.example.com/api/integrations/meta-ads?performance=1'), loader);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accountId, null);
  assert.equal(calls.mock.callCount(), 1);
});

test('expired or revoked grants fail before any Meta request', async t => {
  setup(t);
  const calls = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not execute'); });
  for (const token of [{ revoked_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }, { revoked_at: null, expires_at: new Date(0).toISOString() }]) {
    t.mock.method(pool, 'query', async (sql: string) => ({ rows: sql.includes('FROM oauth_connections')
      ? [{ id: '19', status: 'connected' }]
      : [{ id: '20', access_token_enc: encryptToken('test-token'), ...token }], rowCount: 1 }));
    assert.equal((await handleMetaAds(new Request('https://aries.example.com/api/integrations/meta-ads'), loader)).status, 409);
  }
  assert.equal(calls.mock.callCount(), 0);
});

test('malformed or incomplete provider lists fail closed and never leak provider errors', async t => {
  setup(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [], paging: { next: 'secret-bearing-next-url' } }));
  const response = await handleMetaAds(new Request('https://aries.example.com/api/integrations/meta-ads'), loader);
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('secret-bearing'), false);
});

test('unauthenticated requests and spend methods perform no provider or DB work', async t => {
  const queries = setup(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not execute'); });
  const response = await handleMetaAds(new Request('https://aries.example.com/api/integrations/meta-ads', { method: 'PUT', body: JSON.stringify({ approved: true, budget: 100 }) }), loader);
  assert.equal(response.status, 405);
  assert.equal(queries.length, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
  const unauthenticated = await handleMetaAds(new Request('https://aries.example.com/api/integrations/meta-ads'), async () => { throw new Error('Authentication required'); });
  assert.equal(unauthenticated.status, 403);
  assert.equal(queries.length, 0);
});

test('Meta Ads callback stores an encrypted user grant, verifies permissions, never discovers Pages', async t => {
  setup(t);
  const queries: { sql: string; params: any[] }[] = [];
  t.mock.method(pool, 'query', async (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('FROM oauth_pending_states')) return { rows: [{ state: 'state-test', tenant_id: '75', provider: 'meta_ads', redirect_uri: 'https://aries.example.com/api/auth/oauth/meta_ads/callback', scopes: ['ads_read', 'ads_management'], expires_at: new Date(Date.now() + 60000).toISOString() }], rowCount: 1 };
    return { rows: [{ id: '19' }], rowCount: 1 };
  });
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    if (url.pathname.endsWith('/oauth/access_token')) return Response.json({ access_token: 'test-user-token', expires_in: 3600 });
    assert.equal(url.pathname.endsWith('/me/permissions'), true);
    return Response.json({ data: [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'granted' }] });
  });
  const result = await oauthCallback('meta_ads', { state: 'state-test', code: 'test-code' });
  assert.equal(result.broker_status, 'ok');
  const tokenInsert = queries.find(q => q.sql.includes('INSERT INTO oauth_tokens'))!;
  assert.notEqual(tokenInsert.params[1], 'test-user-token');
  const connection = queries.find(q => q.sql.includes('INSERT INTO oauth_connections'))!;
  assert.equal(connection.params[1], 'meta_ads');
  assert.equal(connection.params[8], null);
});
