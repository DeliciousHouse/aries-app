import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureInsightsAccountsForConnectedPlatforms,
  BRIDGED_PLATFORMS,
} from '@/backend/insights/sync/ensure-account';
import type { Queryable } from '@/backend/integrations/composio/connection-store';
import { getAdapter, hasAdapter } from '@/backend/insights/sync/adapter-factory';
import { FacebookInsightsAdapter } from '@/backend/insights/adapters/facebook/index';

interface RecordedQuery {
  text: string;
  params: unknown[];
}

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

  const result = await ensureInsightsAccountsForConnectedPlatforms(db);

  assert.equal(result.considered, 1);
  assert.equal(result.upserted, 1);

  const select = db.queries[0];
  assert.match(select.text, /FROM connected_accounts/);
  assert.match(select.text, /status = 'connected'/);
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
  const result = await ensureInsightsAccountsForConnectedPlatforms(db);
  assert.equal(result.considered, 0);
  assert.equal(result.upserted, 0);
  // no INSERT issued when there are no connected source rows
  assert.equal(db.queries.length, 1);
});

test('facebook is registered in the adapter factory and getAdapter binds the connection context', async () => {
  assert.equal(hasAdapter('facebook'), true);

  // getAdapter must build a real Composio gateway, which needs an API key.
  const prevKey = process.env.COMPOSIO_API_KEY;
  process.env.COMPOSIO_API_KEY = 'test-key';
  try {
    const adapter = getAdapter('facebook', { connectedAccountId: 'ca_x', pageId: 'PAGE123' });
    assert.ok(adapter instanceof FacebookInsightsAdapter);
    assert.equal(adapter.platform, 'facebook');
  } finally {
    if (prevKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = prevKey;
  }
});
