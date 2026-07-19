import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  stampInsightsPostAttribution,
  type AttributionQueryable,
} from '../backend/insights/sync/attribution-writer';
import { persistPublishedPost } from '../backend/integrations/publish-verification';

type QueryCall = { sql: string; params: unknown[] };

function recordingDb(rowCounts: number[] = []): { db: AttributionQueryable; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const db: AttributionQueryable = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: rowCounts[calls.length - 1] ?? 0 };
    },
  };
  return { db, calls };
}

test('stampInsightsPostAttribution links a tenant/platform match without overwriting attribution', async () => {
  const { db, calls } = recordingDb([1]);

  const stamped = await stampInsightsPostAttribution({
    db,
    tenantId: 15,
    ariesPostId: '901',
    platform: 'instagram',
    platformPostId: '17890001234567890',
  });

  assert.equal(stamped, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE insights_posts/i);
  assert.match(calls[0].sql, /tenant_id\s*=\s*\$2/i);
  assert.match(calls[0].sql, /platform\s*=\s*\$3/i);
  assert.match(calls[0].sql, /external_post_id\s*=\s*\$4/i);
  assert.match(calls[0].sql, /aries_post_id\s+IS\s+NULL/i);
  assert.deepEqual(calls[0].params, ['901', 15, 'instagram', '17890001234567890']);
});

test('stampInsightsPostAttribution normalizes legacy meta to facebook', async () => {
  const { db, calls } = recordingDb();

  await stampInsightsPostAttribution({
    db,
    tenantId: '15',
    ariesPostId: 902,
    platform: ' Meta ',
    platformPostId: '123_456',
  });

  assert.deepEqual(calls[0].params, ['902', 15, 'facebook', '123_456']);
});

test('direct publish persistence stamps an already-synced Insights row after creating the source post', async () => {
  const calls: QueryCall[] = [];
  const db: AttributionQueryable = {
    query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/INSERT INTO posts/i.test(sql)) {
        return { rows: [{ id: '904' }] as unknown as T[], rowCount: 1 };
      }
      return { rows: [] as T[], rowCount: 1 };
    },
  };

  const result = await persistPublishedPost({
    tenantId: 15,
    caption: 'Published by Aries',
    platformPostId: 'page_904',
    publishedAt: new Date('2026-07-19T12:00:00Z'),
    publishedStatus: 'published',
    platform: 'facebook',
  }, db as Pool);

  assert.equal(result.postId, '904');
  const attributionWrite = calls.find((call) => /UPDATE insights_posts/i.test(call.sql));
  assert.ok(attributionWrite, 'direct publish must attempt the additive Insights attribution stamp');
  assert.match(attributionWrite.sql, /aries_post_id\s+IS\s+NULL/i);
  assert.deepEqual(attributionWrite.params, ['904', 15, 'facebook', 'page_904']);
});

test('idempotent direct publish replay still stamps an already-synced Insights row', async () => {
  const calls: QueryCall[] = [];
  const db: AttributionQueryable = {
    query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/SELECT id, platform_post_id FROM posts/i.test(sql)) {
        return {
          rows: [{ id: '905', platform_post_id: 'page_905' }] as unknown as T[],
          rowCount: 1,
        };
      }
      return { rows: [] as T[], rowCount: 1 };
    },
  };

  const result = await persistPublishedPost({
    tenantId: 15,
    caption: 'Published once',
    platformPostId: 'retry_payload_id',
    publishedAt: new Date('2026-07-19T12:00:00Z'),
    publishedStatus: 'published',
    platform: 'facebook',
    idempotencyKey: 'job:post:facebook',
  }, db as Pool);

  assert.equal(result.postId, '905');
  assert.equal(calls.some((call) => /INSERT INTO posts/i.test(call.sql)), false);
  const attributionWrite = calls.find((call) => /UPDATE insights_posts/i.test(call.sql));
  assert.ok(attributionWrite);
  assert.deepEqual(attributionWrite.params, ['905', 15, 'facebook', 'page_905']);
});

test('Insights attribution failure never turns a confirmed direct publish into an error', async () => {
  const db: AttributionQueryable = {
    query: async <T = Record<string, unknown>>(sql: string) => {
      if (/INSERT INTO posts/i.test(sql)) {
        return { rows: [{ id: '906' }] as unknown as T[], rowCount: 1 };
      }
      if (/UPDATE insights_posts/i.test(sql)) {
        throw new Error('analytics unavailable');
      }
      return { rows: [] as T[], rowCount: 0 };
    },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await persistPublishedPost({
      tenantId: 15,
      caption: 'Publish remains successful',
      platformPostId: 'page_906',
      publishedAt: new Date('2026-07-19T12:00:00Z'),
      publishedStatus: 'published',
      platform: 'facebook',
    }, db as Pool);

    assert.equal(result.postId, '906');
  } finally {
    console.warn = originalWarn;
  }
});
