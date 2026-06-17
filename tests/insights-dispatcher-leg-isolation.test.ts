import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syncAccountForTenant } from '@/backend/insights/sync/dispatcher';
import type { InsightsAdapter } from '@/backend/insights/adapters/_adapter.types';

/**
 * M3 regression: a per-post fetchPostMetrics throw must NOT skip the comments
 * leg (#597). Drives the dispatcher against an in-memory fake pool + a fake
 * adapter whose fetchPostMetrics always throws, and asserts comments still
 * ingest and the run is downgraded to 'partial' (not 'failed', not 'ok').
 */

interface Recorded { text: string; params: unknown[] }

function fakePool(recorded: Recorded[]) {
  const client = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      recorded.push({ text, params });
      const rows = (): T[] => [] as T[];

      if (/FROM insights_accounts\s+WHERE id/i.test(text)) {
        return { rows: [{ id: 7, platform: 'facebook', external_account_id: 'PAGE123' }] as unknown as T[], rowCount: 1 };
      }
      if (/FROM connected_accounts/i.test(text)) {
        return {
          rows: [{
            id: 1, tenant_id: 42, external_user_id: 'u', platform: 'facebook', provider: 'composio',
            connected_account_id: 'ca_1', auth_config_id: 'ac', external_account_id: 'PAGE123',
            external_account_name: 'Page', status: 'connected', capabilities_json: null,
            last_capability_check_at: null, created_at: new Date(0), updated_at: new Date(0),
          }] as unknown as T[],
          rowCount: 1,
        };
      }
      if (/INSERT INTO insights_sync_runs/i.test(text)) {
        return { rows: [{ id: 99 }] as unknown as T[], rowCount: 1 };
      }
      if (/SELECT id, external_post_id\s+FROM insights_posts/i.test(text)) {
        // Serves BOTH the post-metrics (postsToSync) and the comments (recentPosts) selects.
        return { rows: [{ id: 10, external_post_id: 'PAGE123_1' }] as unknown as T[], rowCount: 1 };
      }
      return { rows: rows(), rowCount: 0 };
    },
    release() {},
  };
  return { async connect() { return client; } };
}

const throwingPostMetricsAdapter: InsightsAdapter = {
  platform: 'facebook',
  fetchPostList: async () => [],
  fetchAccountMetrics: async () => [],
  fetchPostMetrics: async () => {
    throw new Error('POST_INSIGHTS 500');
  },
  fetchComments: async () => [
    { externalCommentId: 'PAGE123_1_99', receivedAt: new Date('2026-06-11T00:00:00Z'), authorHandle: 'Jane', bodyText: 'hi' },
  ],
};

test('M3: comments still ingest when fetchPostMetrics throws; run is partial, not failed/ok', async () => {
  const recorded: Recorded[] = [];
  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded),
    resolveAdapter: () => throwingPostMetricsAdapter,
  });

  // The comments leg ran despite the post-metrics throw.
  const commentInserts = recorded.filter((q) => /INSERT INTO insights_comments/i.test(q.text));
  assert.equal(commentInserts.length, 1, 'a comment was inserted even though fetchPostMetrics threw');
  assert.equal(result.commentsSeen, 1);

  // The run is downgraded to partial (leg isolated), never the ok fast-path,
  // never a hard failure that would zero everything.
  assert.equal(result.status, 'partial');
  assert.match(String(result.errorMessage), /fetchPostMetrics/);
  assert.match(String(result.errorMessage), /POST_INSIGHTS 500/);

  const partialUpdate = recorded.find((q) => /UPDATE insights_sync_runs[\s\S]*status = 'partial'/i.test(q.text));
  assert.ok(partialUpdate, 'the sync run is closed out as partial');
  const okTerminal = recorded.find((q) => /UPDATE insights_sync_runs[\s\S]*status\s*=\s*'ok'/i.test(q.text));
  assert.equal(okTerminal, undefined, 'the ok fast-path must not run when a leg failed');
});

test('M3: a clean run (no leg errors) still takes the ok path', async () => {
  const recorded: Recorded[] = [];
  const cleanAdapter: InsightsAdapter = {
    ...throwingPostMetricsAdapter,
    fetchPostMetrics: async () => [],
  };
  const result = await syncAccountForTenant(42, 7, 'interval', {
    pool: fakePool(recorded),
    resolveAdapter: () => cleanAdapter,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.errorMessage, undefined);
});
