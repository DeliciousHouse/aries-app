import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureInsightsAccountsForConnectedPlatforms,
  BRIDGED_PLATFORMS,
} from '@/backend/insights/sync/ensure-account';
import type { Queryable } from '@/backend/integrations/composio/connection-store';
import { getAdapter, hasAdapter, isFacebookInsightsEnabled } from '@/backend/insights/sync/adapter-factory';
import { FacebookInsightsAdapter } from '@/backend/insights/adapters/facebook/index';
import { DEFAULT_LIST_MANAGED_PAGES_SLUG } from '@/backend/integrations/composio/facebook-page-resolver';
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
  assert.equal(result.skippedReason, 'analytics_provider_not_composio');
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
