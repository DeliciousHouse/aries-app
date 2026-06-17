import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureInsightsAccountsForConnectedPlatforms,
  BRIDGED_PLATFORMS,
} from '@/backend/insights/sync/ensure-account';
import type { Queryable } from '@/backend/integrations/composio/connection-store';
import { getAdapter, hasAdapter, isFacebookInsightsEnabled } from '@/backend/insights/sync/adapter-factory';
import { FacebookInsightsAdapter } from '@/backend/insights/adapters/facebook/index';

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

test('the bridge upserts an insights_accounts row from a connected Composio FB connection', async () => {
  const db = recordingDb([
    {
      tenant_id: 15,
      platform: 'facebook',
      external_account_id: 'PAGE123',
      external_account_name: 'Sugar & Leather',
    },
  ]);

  const result = await ensureInsightsAccountsForConnectedPlatforms(db, COMPOSIO_ENV);

  assert.equal(result.considered, 1);
  assert.equal(result.upserted, 1);

  const select = db.queries[0];
  assert.match(select.text, /FROM connected_accounts/);
  assert.match(select.text, /status = 'connected'/);
  assert.match(select.text, /provider = 'composio'/); // L1: only Composio-backed connections
  assert.match(select.text, /connected_account_id IS NOT NULL/);
  assert.match(select.text, /external_account_id IS NOT NULL/);
  assert.deepEqual(select.params, [...BRIDGED_PLATFORMS]);

  const insert = db.queries[1];
  assert.match(insert.text, /INSERT INTO insights_accounts/);
  assert.match(insert.text, /ON CONFLICT \(tenant_id, platform, external_account_id\) DO UPDATE/);
  // page id (external_account_id) is mapped through unchanged.
  assert.deepEqual(insert.params, [15, 'facebook', 'PAGE123', 'Sugar & Leather']);
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
