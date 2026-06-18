import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureInsightsAccountsForConnectedPlatforms,
  BRIDGED_PLATFORMS,
} from '@/backend/insights/sync/ensure-account';
import type { Queryable } from '@/backend/integrations/composio/connection-store';
import { getAdapter, hasAdapter, isFacebookInsightsEnabled, isComposioOnlyAnalyticsPlatform, isPlatformInsightsEnabled } from '@/backend/insights/sync/adapter-factory';
import { FacebookInsightsAdapter } from '@/backend/insights/adapters/facebook/index';
import { DEFAULT_LIST_MANAGED_PAGES_SLUG } from '@/backend/integrations/composio/facebook-page-resolver';
import { DEFAULT_X_GET_ME_SLUG } from '@/backend/integrations/composio/x-user-resolver';
import { DEFAULT_REDDIT_GET_ME_SLUG } from '@/backend/integrations/composio/reddit-user-resolver';
import { fakeConfig, fakeGateway } from './composio/helpers';

interface RecordedQuery {
  text: string;
  params: unknown[];
}

const COMPOSIO_ENV = { ANALYTICS_PROVIDER: 'composio' } as unknown as NodeJS.ProcessEnv;
const DIRECT_ENV = { ANALYTICS_PROVIDER: 'direct_meta' } as unknown as NodeJS.ProcessEnv;

function recordingDb(connectedRows: Array<Record<string, unknown>>): Queryable & { queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      if (/^\s*select/i.test(text) && /connected_accounts/i.test(text)) {
        return { rows: connectedRows as T[], rowCount: connectedRows.length };
      }
      // INSERT ... ON CONFLICT — report one row affected.
      return { rows: [] as T[], rowCount: 1 };
    },
  };
}

test('the bridge upserts an insights_accounts row from a connected Composio FB connection (id present, no resolution)', async () => {
  const db = recordingDb([
    {
      id: 5,
      tenant_id: 15,
      platform: 'facebook',
      external_account_id: 'PAGE123',
      external_account_name: 'Sugar & Leather',
      connected_account_id: 'ca_1',
    },
  ]);
  // A gateway that would throw if called — proves no resolution happens when the
  // page id is already present.
  const gateway = fakeGateway();

  const result = await ensureInsightsAccountsForConnectedPlatforms(db, COMPOSIO_ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
  });

  assert.equal(result.considered, 1);
  assert.equal(result.upserted, 1);
  assert.equal(result.resolved, 0);
  assert.equal(gateway.calls.length, 0, 'no Composio call when external_account_id is present');

  const select = db.queries[0];
  assert.match(select.text, /FROM connected_accounts/);
  assert.match(select.text, /status = 'connected'/);
  assert.match(select.text, /provider = 'composio'/); // L1: only Composio-backed connections
  assert.match(select.text, /connected_account_id IS NOT NULL/);
  // The external_account_id filter is intentionally GONE so null rows are back-healed.
  assert.doesNotMatch(select.text, /external_account_id IS NOT NULL/);
  assert.deepEqual(select.params, [...BRIDGED_PLATFORMS]);

  const insert = db.queries[1];
  assert.match(insert.text, /INSERT INTO insights_accounts/);
  assert.match(insert.text, /ON CONFLICT \(tenant_id, platform, external_account_id\) DO UPDATE/);
  // page id (external_account_id) is mapped through unchanged.
  assert.deepEqual(insert.params, [15, 'facebook', 'PAGE123', 'Sugar & Leather']);
});

test('the bridge resolves + persists the Page id from Composio when external_account_id is null', async () => {
  const db = recordingDb([
    {
      id: 9,
      tenant_id: 15,
      platform: 'facebook',
      external_account_id: null,
      external_account_name: null,
      connected_account_id: 'ca_live',
    },
  ]);
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: [{ id: 'PAGE777', name: 'Aries Page' }] },
    },
  });

  const result = await ensureInsightsAccountsForConnectedPlatforms(db, COMPOSIO_ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
  });

  assert.equal(result.resolved, 1);
  assert.equal(result.upserted, 1);
  assert.equal(result.skippedNoPage, 0);

  // It called FACEBOOK_LIST_MANAGED_PAGES with the connection's connectedAccountId.
  assert.equal(gateway.calls[0].slug, DEFAULT_LIST_MANAGED_PAGES_SLUG);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_live');

  // It persisted the resolved Page id back to connected_accounts.
  const update = db.queries.find((q) => /UPDATE connected_accounts/i.test(q.text));
  assert.ok(update, 'persists the resolved page id back to connected_accounts');
  assert.equal(update!.params[0], 'PAGE777');
  assert.equal(update!.params[2], 9); // keyed on the connection row id

  // And upserted insights_accounts with the resolved Page id + name.
  const insert = db.queries.find((q) => /INSERT INTO insights_accounts/i.test(q.text));
  assert.deepEqual(insert!.params, [15, 'facebook', 'PAGE777', 'Aries Page']);
});

test('the bridge skips safely (no upsert, no throw) when Composio returns no managed page', async () => {
  const db = recordingDb([
    {
      id: 9,
      tenant_id: 15,
      platform: 'facebook',
      external_account_id: null,
      external_account_name: null,
      connected_account_id: 'ca_live',
    },
  ]);
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: [] } },
  });

  const result = await ensureInsightsAccountsForConnectedPlatforms(db, COMPOSIO_ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
  });

  assert.equal(result.resolved, 0);
  assert.equal(result.upserted, 0);
  assert.equal(result.skippedNoPage, 1);
  assert.equal(db.queries.find((q) => /INSERT INTO insights_accounts/i.test(q.text)), undefined);
  assert.equal(db.queries.find((q) => /UPDATE connected_accounts/i.test(q.text)), undefined);
});

test('the bridge does not throw when Composio resolution errors — it skips the tenant', async () => {
  const db = recordingDb([
    {
      id: 9,
      tenant_id: 15,
      platform: 'facebook',
      external_account_id: null,
      external_account_name: null,
      connected_account_id: 'ca_live',
    },
  ]);
  const throwingGateway = {
    ...fakeGateway(),
    async executeTool() {
      throw new Error('Composio 500');
    },
  };

  const result = await ensureInsightsAccountsForConnectedPlatforms(db, COMPOSIO_ENV, {
    gateway: throwingGateway,
    config: fakeConfig({ actions: {} }),
  });

  assert.equal(result.skippedNoPage, 1);
  assert.equal(result.upserted, 0);
});

test('Instagram is out of scope: the bridge only queries the bridged (FB) platforms', async () => {
  assert.deepEqual([...BRIDGED_PLATFORMS], ['facebook']);
  const db = recordingDb([]);
  const result = await ensureInsightsAccountsForConnectedPlatforms(db, COMPOSIO_ENV);
  assert.equal(result.considered, 0);
  assert.equal(result.upserted, 0);
  // no INSERT issued when there are no connected source rows
  assert.equal(db.queries.length, 1);
});

test('M4 off-switch: the bridge no-ops (no DB query) when ANALYTICS_PROVIDER != composio', async () => {
  const db = recordingDb([
    { tenant_id: 15, platform: 'facebook', external_account_id: 'PAGE123', external_account_name: 'X' },
  ]);
  const result = await ensureInsightsAccountsForConnectedPlatforms(db, DIRECT_ENV);
  assert.equal(result.upserted, 0);
  assert.equal(result.skippedReason, 'no_enabled_analytics_platforms');
  assert.equal(db.queries.length, 0, 'no DB query at all when the path is disabled');
});

test('M4 off-switch: hasAdapter(facebook) honors ANALYTICS_PROVIDER, getAdapter throws when off', () => {
  assert.equal(isFacebookInsightsEnabled(COMPOSIO_ENV), true);
  assert.equal(isFacebookInsightsEnabled(DIRECT_ENV), false);
  assert.equal(hasAdapter('facebook', COMPOSIO_ENV), true);
  assert.equal(hasAdapter('facebook', DIRECT_ENV), false);

  const prev = process.env.ANALYTICS_PROVIDER;
  process.env.ANALYTICS_PROVIDER = 'direct_meta';
  try {
    assert.throws(() => getAdapter('facebook', { connectedAccountId: 'ca_x' }), /ANALYTICS_PROVIDER=composio/);
  } finally {
    if (prev === undefined) delete process.env.ANALYTICS_PROVIDER;
    else process.env.ANALYTICS_PROVIDER = prev;
  }
});

test('X bridge: when ARIES_X_ENABLED=1 the DB query includes "x" alongside "facebook"', async () => {
  const db = recordingDb([]);
  const xEnv = {
    ANALYTICS_PROVIDER: 'composio',
    COMPOSIO_ENABLED: '1',
    ARIES_X_ENABLED: '1',
  } as unknown as NodeJS.ProcessEnv;
  await ensureInsightsAccountsForConnectedPlatforms(db, xEnv);
  const select = db.queries[0];
  assert.ok(select, 'issued a SELECT query');
  // The bridged-platform list must include 'x' when the rollout flag is on.
  assert.ok(
    Array.isArray(select.params) && (select.params as unknown[]).includes('x'),
    'x is in bridged-platform params when ARIES_X_ENABLED=1',
  );
  assert.ok(
    Array.isArray(select.params) && (select.params as unknown[]).includes('facebook'),
    'facebook is always included',
  );
});

test('X bridge: when ARIES_X_ENABLED is off, the DB query only includes "facebook"', async () => {
  const db = recordingDb([]);
  const fbOnlyEnv = { ANALYTICS_PROVIDER: 'composio' } as unknown as NodeJS.ProcessEnv;
  await ensureInsightsAccountsForConnectedPlatforms(db, fbOnlyEnv);
  const select = db.queries[0];
  assert.ok(select, 'issued a SELECT query');
  assert.deepEqual(select.params, ['facebook'], 'only facebook when ARIES_X_ENABLED is off');
});

test('YouTube bridge: when ARIES_YOUTUBE_ENABLED=1 the DB query includes "youtube" alongside "facebook"', async () => {
  const db = recordingDb([]);
  const ytEnv = {
    ANALYTICS_PROVIDER: 'composio',
    COMPOSIO_ENABLED: '1',
    ARIES_YOUTUBE_ENABLED: '1',
  } as unknown as NodeJS.ProcessEnv;
  await ensureInsightsAccountsForConnectedPlatforms(db, ytEnv);
  const select = db.queries[0];
  assert.ok(select, 'issued a SELECT query');
  // The bridged-platform list must include 'youtube' when the rollout flag is on.
  assert.ok(
    Array.isArray(select.params) && (select.params as unknown[]).includes('youtube'),
    'youtube is in bridged-platform params when ARIES_YOUTUBE_ENABLED=1',
  );
  assert.ok(
    Array.isArray(select.params) && (select.params as unknown[]).includes('facebook'),
    'facebook is always included',
  );
});

test('YouTube bridge: when ARIES_YOUTUBE_ENABLED is off, the DB query does NOT include "youtube"', async () => {
  const db = recordingDb([]);
  const fbOnlyEnv = { ANALYTICS_PROVIDER: 'composio' } as unknown as NodeJS.ProcessEnv;
  await ensureInsightsAccountsForConnectedPlatforms(db, fbOnlyEnv);
  const select = db.queries[0];
  assert.ok(select, 'issued a SELECT query');
  assert.ok(
    !(select.params as unknown[]).includes('youtube'),
    'youtube is NOT in bridged-platform params when ARIES_YOUTUBE_ENABLED is off',
  );
});

test('Reddit bridge: when ARIES_REDDIT_ENABLED=1 the DB query includes "reddit" alongside "facebook"', async () => {
  const db = recordingDb([]);
  const redditEnv = {
    ANALYTICS_PROVIDER: 'composio',
    COMPOSIO_ENABLED: '1',
    ARIES_REDDIT_ENABLED: '1',
  } as unknown as NodeJS.ProcessEnv;
  await ensureInsightsAccountsForConnectedPlatforms(db, redditEnv);
  const select = db.queries[0];
  assert.ok(select, 'issued a SELECT query');
  // The bridged-platform list must include 'reddit' when the rollout flag is on.
  assert.ok(
    Array.isArray(select.params) && (select.params as unknown[]).includes('reddit'),
    'reddit is in bridged-platform params when ARIES_REDDIT_ENABLED=1',
  );
  assert.ok(
    Array.isArray(select.params) && (select.params as unknown[]).includes('facebook'),
    'facebook is always included',
  );
});

test('LinkedIn bridge: when ARIES_LINKEDIN_ENABLED=1 the DB query includes "linkedin" alongside "facebook"', async () => {
  const db = recordingDb([]);
  const liEnv = {
    ANALYTICS_PROVIDER: 'composio',
    COMPOSIO_ENABLED: '1',
    ARIES_LINKEDIN_ENABLED: '1',
  } as unknown as NodeJS.ProcessEnv;
  await ensureInsightsAccountsForConnectedPlatforms(db, liEnv);
  const select = db.queries[0];
  assert.ok(select, 'issued a SELECT query');
  // The bridged-platform list must include 'linkedin' when the rollout flag is on.
  assert.ok(
    Array.isArray(select.params) && (select.params as unknown[]).includes('linkedin'),
    'linkedin is in bridged-platform params when ARIES_LINKEDIN_ENABLED=1',
  );
  assert.ok(
    Array.isArray(select.params) && (select.params as unknown[]).includes('facebook'),
    'facebook is always included',
  );
});

test('Reddit bridge: when ARIES_REDDIT_ENABLED is off, the DB query does NOT include "reddit"', async () => {
  const db = recordingDb([]);
  const fbOnlyEnv = { ANALYTICS_PROVIDER: 'composio' } as unknown as NodeJS.ProcessEnv;
  await ensureInsightsAccountsForConnectedPlatforms(db, fbOnlyEnv);
  const select = db.queries[0];
  assert.ok(select, 'issued a SELECT query');
  assert.ok(
    !(select.params as unknown[]).includes('reddit'),
    'reddit is NOT in bridged-platform params when ARIES_REDDIT_ENABLED is off',
  );
});

test('LinkedIn bridge: when ARIES_LINKEDIN_ENABLED is off, the DB query does NOT include "linkedin"', async () => {
  const db = recordingDb([]);
  const fbOnlyEnv = { ANALYTICS_PROVIDER: 'composio' } as unknown as NodeJS.ProcessEnv;
  await ensureInsightsAccountsForConnectedPlatforms(db, fbOnlyEnv);
  const select = db.queries[0];
  assert.ok(select, 'issued a SELECT query');
  assert.ok(
    !(select.params as unknown[]).includes('linkedin'),
    'linkedin is NOT in bridged-platform params when ARIES_LINKEDIN_ENABLED is off',
  );
});

// ── X back-heal (#670) ────────────────────────────────────────────────────────

test('X bridge back-heals the username and upserts an insights_accounts row', async () => {
  const db = recordingDb([
    {
      id: 20,
      tenant_id: 15,
      platform: 'x',
      external_account_id: null,
      external_account_name: null,
      connected_account_id: 'ca_x',
    },
  ]);
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { id: '123', username: 'sugarleather', name: 'Sugar & Leather' } },
    },
  });

  const result = await ensureInsightsAccountsForConnectedPlatforms(
    db,
    { ANALYTICS_PROVIDER: 'composio', COMPOSIO_ENABLED: '1', ARIES_X_ENABLED: '1' } as unknown as NodeJS.ProcessEnv,
    { gateway, config: fakeConfig({ actions: {} }) },
  );

  assert.equal(result.resolved, 1);
  assert.equal(result.upserted, 1);
  assert.equal(result.skippedNoPage, 0);

  // It called TWITTER_USER_LOOKUP_ME with the connection's connectedAccountId.
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].slug, DEFAULT_X_GET_ME_SLUG);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_x');

  // It persisted the resolved username back to connected_accounts.
  const update = db.queries.find((q) => /UPDATE connected_accounts/i.test(q.text));
  assert.ok(update, 'persists the resolved username back to connected_accounts');
  assert.equal(update!.params[0], 'sugarleather');
  assert.equal(update!.params[2], 20); // keyed on the connection row id

  // And upserted insights_accounts with the resolved username + display name.
  const insert = db.queries.find((q) => /INSERT INTO insights_accounts/i.test(q.text));
  assert.deepEqual(insert!.params, [15, 'x', 'sugarleather', 'Sugar & Leather']);
});

test('Reddit bridge back-heals the username and upserts an insights_accounts row', async () => {
  const db = recordingDb([
    {
      id: 21,
      tenant_id: 15,
      platform: 'reddit',
      external_account_id: null,
      external_account_name: null,
      connected_account_id: 'ca_reddit',
    },
  ]);
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { name: 'sugarleather' } },
    },
  });

  const result = await ensureInsightsAccountsForConnectedPlatforms(
    db,
    { ANALYTICS_PROVIDER: 'composio', COMPOSIO_ENABLED: '1', ARIES_REDDIT_ENABLED: '1' } as unknown as NodeJS.ProcessEnv,
    { gateway, config: fakeConfig({ actions: {} }) },
  );

  assert.equal(result.resolved, 1);
  assert.equal(result.upserted, 1);
  assert.equal(result.skippedNoPage, 0);

  // It called REDDIT_GET_REDDIT_USER_ABOUT with the right connectedAccountId and
  // the Reddit-required arguments:{username:'me'}.
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].slug, DEFAULT_REDDIT_GET_ME_SLUG);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_reddit');
  assert.deepEqual(gateway.calls[0].options.arguments, { username: 'me' });

  // It persisted the resolved username back to connected_accounts.
  const update = db.queries.find((q) => /UPDATE connected_accounts/i.test(q.text));
  assert.ok(update, 'persists the resolved username back to connected_accounts');
  assert.equal(update!.params[0], 'sugarleather');
  assert.equal(update!.params[2], 21);

  // And upserted insights_accounts with the resolved username.
  // For Reddit, username === name (the t2 `name` field is the Redditor handle).
  const insert = db.queries.find((q) => /INSERT INTO insights_accounts/i.test(q.text));
  assert.deepEqual(insert!.params, [15, 'reddit', 'sugarleather', 'sugarleather']);
});

// ── Regression guards: existing resolvers unaffected by new dispatch branches ──

test('regression: FB row with external_account_id set still upserts directly when X is also enabled', async () => {
  const db = recordingDb([
    {
      id: 5,
      tenant_id: 15,
      platform: 'facebook',
      external_account_id: 'PAGE456',
      external_account_name: 'Leather FB Page',
      connected_account_id: 'ca_fb',
    },
  ]);
  // Proves no resolution happens for FB when external_account_id is already present.
  const gateway = fakeGateway();

  const result = await ensureInsightsAccountsForConnectedPlatforms(
    db,
    { ANALYTICS_PROVIDER: 'composio', COMPOSIO_ENABLED: '1', ARIES_X_ENABLED: '1' } as unknown as NodeJS.ProcessEnv,
    { gateway, config: fakeConfig({ actions: {} }) },
  );

  assert.equal(result.considered, 1);
  assert.equal(result.upserted, 1);
  assert.equal(result.resolved, 0);
  assert.equal(gateway.calls.length, 0, 'no Composio call for FB row with existing external_account_id');

  const insert = db.queries.find((q) => /INSERT INTO insights_accounts/i.test(q.text));
  assert.deepEqual(insert!.params, [15, 'facebook', 'PAGE456', 'Leather FB Page']);
});

test('regression: YouTube back-heal still routes to channel resolver when X and Reddit are also enabled', async () => {
  const db = recordingDb([
    {
      id: 30,
      tenant_id: 15,
      platform: 'youtube',
      external_account_id: null,
      external_account_name: null,
      connected_account_id: 'ca_yt',
    },
  ]);
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { items: [{ id: 'UCchannel123', snippet: { title: 'Aries YT' } }] },
    },
  });

  const result = await ensureInsightsAccountsForConnectedPlatforms(
    db,
    {
      ANALYTICS_PROVIDER: 'composio',
      COMPOSIO_ENABLED: '1',
      ARIES_YOUTUBE_ENABLED: '1',
      ARIES_X_ENABLED: '1',
      ARIES_REDDIT_ENABLED: '1',
    } as unknown as NodeJS.ProcessEnv,
    { gateway, config: fakeConfig({ actions: {} }) },
  );

  assert.equal(result.resolved, 1);
  assert.equal(result.upserted, 1);
  assert.equal(result.skippedNoPage, 0);

  // Verify the YouTube channel resolver was used (not the X or Reddit resolver).
  const insert = db.queries.find((q) => /INSERT INTO insights_accounts/i.test(q.text));
  assert.equal(insert!.params[1], 'youtube', 'platform column is youtube');
  assert.equal(insert!.params[2], 'UCchannel123', 'YouTube channel id resolved correctly');
  assert.equal(insert!.params[3], 'Aries YT', 'YouTube channel name resolved correctly');
});

test('facebook is registered in the adapter factory and getAdapter binds the connection context', () => {
  // getAdapter builds a real Composio gateway (needs an API key) AND requires
  // the ANALYTICS_PROVIDER=composio off-switch to be on.
  const prevKey = process.env.COMPOSIO_API_KEY;
  const prevProvider = process.env.ANALYTICS_PROVIDER;
  process.env.COMPOSIO_API_KEY = 'test-key';
  process.env.ANALYTICS_PROVIDER = 'composio';
  try {
    assert.equal(hasAdapter('facebook'), true);
    const adapter = getAdapter('facebook', { connectedAccountId: 'ca_x', pageId: 'PAGE123' });
    assert.ok(adapter instanceof FacebookInsightsAdapter);
    assert.equal(adapter.platform, 'facebook');
  } finally {
    if (prevKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = prevKey;
    if (prevProvider === undefined) delete process.env.ANALYTICS_PROVIDER;
    else process.env.ANALYTICS_PROVIDER = prevProvider;
  }
});

// ── Adversarial tests: #679 composio-only analytics seam ──────────────────────

test('#679 (a) golden — FB path byte-identical to pre-fix: ANALYTICS_PROVIDER=composio + no rollout flags → SELECT params exactly ["facebook"]', async () => {
  // This behavior must be byte-identical to pre-fix: a plain ANALYTICS_PROVIDER=composio
  // env with no rollout flags must still only bridge facebook and nothing else.
  const db = recordingDb([]);
  const composioFbOnlyEnv = { ANALYTICS_PROVIDER: 'composio' } as unknown as NodeJS.ProcessEnv;
  await ensureInsightsAccountsForConnectedPlatforms(db, composioFbOnlyEnv);
  const select = db.queries[0];
  assert.ok(select, 'a SELECT was issued');
  assert.deepEqual(
    select.params,
    ['facebook'],
    'FB path: params must be exactly ["facebook"] — no composio-only platforms leak in without their own flags',
  );
});

test('#679 (a) golden — direct_meta no-op byte-identical to pre-fix: ANALYTICS_PROVIDER=direct_meta + no flags → zero DB queries', async () => {
  // Pre-fix: early-return fired with skippedReason 'analytics_provider_not_composio'.
  // Post-fix: per-platform bridgedPlatforms() returns [] → same no-op, new reason string.
  const db = recordingDb([]);
  const directMetaEnv = { ANALYTICS_PROVIDER: 'direct_meta' } as unknown as NodeJS.ProcessEnv;
  const result = await ensureInsightsAccountsForConnectedPlatforms(db, directMetaEnv);
  assert.equal(db.queries.length, 0, 'zero DB queries when all platforms are disabled');
  assert.equal(result.upserted, 0);
  assert.equal(result.skippedReason, 'no_enabled_analytics_platforms');
});

test('#679 (b) dormancy — ARIES_REDDIT_ENABLED OFF + COMPOSIO_ENABLED=1 + ANALYTICS_PROVIDER=composio → reddit NOT in SELECT params, no reddit row upserted', async () => {
  // Proves the rollout flag gates reddit independently of COMPOSIO_ENABLED.
  // COMPOSIO_ENABLED=1 is on (Composio globally active) but the Reddit flag is absent.
  const db = recordingDb([]);
  const dormantRedditEnv = {
    COMPOSIO_ENABLED: '1',
    ANALYTICS_PROVIDER: 'composio',
    // ARIES_REDDIT_ENABLED intentionally absent
  } as unknown as NodeJS.ProcessEnv;
  await ensureInsightsAccountsForConnectedPlatforms(db, dormantRedditEnv);
  const select = db.queries[0];
  assert.ok(select, 'a SELECT was issued (facebook is still bridged)');
  assert.ok(
    !(select.params as unknown[]).includes('reddit'),
    'reddit must NOT appear in SELECT params when ARIES_REDDIT_ENABLED is off (dormancy)',
  );
  assert.ok(
    (select.params as unknown[]).includes('facebook'),
    'facebook must still be bridged via ANALYTICS_PROVIDER=composio (independent of COMPOSIO_ENABLED)',
  );
  // No INSERT should have fired for reddit.
  const redditInsert = db.queries.find(
    (q) => /INSERT INTO insights_accounts/i.test(q.text) && q.params[1] === 'reddit',
  );
  assert.equal(redditInsert, undefined, 'no insights_accounts row upserted for reddit when dormant');
});

test('#679 (c) NEW behavior — ARIES_REDDIT_ENABLED=1 + COMPOSIO_ENABLED=1 + ANALYTICS_PROVIDER=direct_meta → SELECT includes "reddit", excludes "facebook"; reddit upserts via Composio back-heal', async () => {
  // THE POINT OF THE FIX: reddit can provision through Composio even when the
  // ANALYTICS_PROVIDER selector is 'direct_meta' (which governs facebook/instagram only).
  //
  // Pre-fix proof this would FAIL: ensure-account.ts had an all-or-nothing early-return:
  //   if (selector !== 'composio') return { skippedReason: 'analytics_provider_not_composio' }
  // With ANALYTICS_PROVIDER=direct_meta, selector!=='composio', so the function returned
  // immediately with upserted=0. The (c) assertion below (upserted===1) would have failed.
  const db = recordingDb([
    {
      id: 21,
      tenant_id: 15,
      platform: 'reddit',
      external_account_id: null,
      external_account_name: null,
      connected_account_id: 'ca_reddit_c',
    },
  ]);
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { name: 'sugar_reddit' } },
    },
  });
  const newBehaviorEnv = {
    ARIES_REDDIT_ENABLED: '1',
    COMPOSIO_ENABLED: '1',
    ANALYTICS_PROVIDER: 'direct_meta',
  } as unknown as NodeJS.ProcessEnv;

  const result = await ensureInsightsAccountsForConnectedPlatforms(db, newBehaviorEnv, {
    gateway,
    config: fakeConfig({ actions: {} }),
  });

  // SELECT params must include 'reddit' and must NOT include 'facebook'.
  const select = db.queries[0];
  assert.ok(select, 'a SELECT was issued');
  assert.ok(
    (select.params as unknown[]).includes('reddit'),
    'reddit must be in SELECT params (ARIES_REDDIT_ENABLED=1 + COMPOSIO_ENABLED=1)',
  );
  assert.ok(
    !(select.params as unknown[]).includes('facebook'),
    'facebook must NOT be in SELECT params (ANALYTICS_PROVIDER=direct_meta disables FB path)',
  );

  // Reddit row must have been resolved via back-heal and upserted.
  assert.equal(result.resolved, 1, 'reddit username was resolved via Composio back-heal');
  assert.equal(result.upserted, 1, 'reddit insights_accounts row was upserted');

  const insert = db.queries.find((q) => /INSERT INTO insights_accounts/i.test(q.text));
  assert.ok(insert, 'an INSERT INTO insights_accounts was issued for reddit');
  assert.deepEqual(insert!.params, [15, 'reddit', 'sugar_reddit', 'sugar_reddit']);
});

test('#679 seam parity — isPlatformInsightsEnabled dispatches correctly for all five platforms', () => {
  const allOffEnv = {} as unknown as NodeJS.ProcessEnv;
  const fbOnlyEnv = { ANALYTICS_PROVIDER: 'composio' } as unknown as NodeJS.ProcessEnv;
  const redditOnlyEnv = { ARIES_REDDIT_ENABLED: '1', COMPOSIO_ENABLED: '1' } as unknown as NodeJS.ProcessEnv;
  const fullEnv = { ANALYTICS_PROVIDER: 'composio', COMPOSIO_ENABLED: '1', ARIES_X_ENABLED: '1', ARIES_REDDIT_ENABLED: '1', ARIES_YOUTUBE_ENABLED: '1', ARIES_LINKEDIN_ENABLED: '1' } as unknown as NodeJS.ProcessEnv;

  // facebook → ANALYTICS_PROVIDER gate (not affected by COMPOSIO_ENABLED)
  assert.equal(isPlatformInsightsEnabled('facebook', fbOnlyEnv), true);
  assert.equal(isPlatformInsightsEnabled('facebook', allOffEnv), false);
  assert.equal(isPlatformInsightsEnabled('facebook', redditOnlyEnv), false, 'ANALYTICS_PROVIDER alone gates FB — COMPOSIO_ENABLED does not enable FB');

  // composio-only platforms → rollout flag + COMPOSIO_ENABLED
  assert.equal(isPlatformInsightsEnabled('reddit', redditOnlyEnv), true);
  assert.equal(isPlatformInsightsEnabled('reddit', fbOnlyEnv), false, 'ANALYTICS_PROVIDER=composio alone does not enable reddit');
  assert.equal(isPlatformInsightsEnabled('reddit', { ARIES_REDDIT_ENABLED: '1' } as unknown as NodeJS.ProcessEnv), false, 'ARIES_REDDIT_ENABLED without COMPOSIO_ENABLED → disabled');

  // All five enabled together
  assert.equal(isPlatformInsightsEnabled('facebook', fullEnv), true);
  assert.equal(isPlatformInsightsEnabled('x', fullEnv), true);
  assert.equal(isPlatformInsightsEnabled('youtube', fullEnv), true);
  assert.equal(isPlatformInsightsEnabled('reddit', fullEnv), true);
  assert.equal(isPlatformInsightsEnabled('linkedin', fullEnv), true);

  // Unknown platform → always false
  assert.equal(isPlatformInsightsEnabled('instagram', fullEnv), false, 'instagram is not in the seam');
  assert.equal(isPlatformInsightsEnabled('unknown', fullEnv), false);
});

test('#679 isComposioOnlyAnalyticsPlatform: set is {x, reddit, linkedin, youtube}; facebook excluded', () => {
  // These four platforms use COMPOSIO_ENABLED as their gate (not ANALYTICS_PROVIDER).
  // NOTE: youtube IS in this set even though it is absent from the publish-only
  // COMPOSIO_ONLY_PUBLISH_PLATFORMS — analytics and publish have different activation axes.
  assert.equal(isComposioOnlyAnalyticsPlatform('x'), true);
  assert.equal(isComposioOnlyAnalyticsPlatform('reddit'), true);
  assert.equal(isComposioOnlyAnalyticsPlatform('linkedin'), true);
  assert.equal(isComposioOnlyAnalyticsPlatform('youtube'), true);
  assert.equal(isComposioOnlyAnalyticsPlatform('facebook'), false, 'facebook uses ANALYTICS_PROVIDER gate, not the composio-only set');
  assert.equal(isComposioOnlyAnalyticsPlatform('instagram'), false, 'instagram is out of scope');
});
