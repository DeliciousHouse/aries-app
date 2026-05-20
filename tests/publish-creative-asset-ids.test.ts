import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import {
  persistPublishedPost,
  runPublishVerification,
} from '../backend/integrations/publish-verification';
import {
  resolveMediaUrls,
  type DispatchQueryable,
} from '../app/api/internal/publishing/scheduled-dispatch/route';

// Regression for TODOS "Populate posts.creative_asset_ids": the marketing
// publish stage (publish-facebook / publish-instagram handlers ->
// runPublishVerification -> persistPublishedPost) creates the `posts` row but
// never wrote `creative_asset_ids`, so every prod row was '{}' and the
// scheduled-dispatch resolver fell back to job-scope — publishing the wrong
// image for a multi-image weekly job. These tests prove the column is now
// written with the post's own asset id AND that resolveMediaUrls then resolves
// per-post, not per-job.

type QueryArgs = { sql: string; params: unknown[] };

function createMockPool(
  handler: (args: QueryArgs) => { rows: unknown[]; rowCount?: number },
): { pool: Pool; calls: QueryArgs[] } {
  const calls: QueryArgs[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const args: QueryArgs = { sql, params };
      calls.push(args);
      return handler(args);
    },
  } as unknown as Pool;
  return { pool, calls };
}

// creative_asset_ids is the LAST column in the INSERT:
// tenant_id, job_id, caption, platform_post_id, published_at,
// published_status, platform, idempotency_key, creative_asset_ids
const CREATIVE_ASSET_IDS_PARAM_INDEX = 8;

test('persistPublishedPost writes creative_asset_ids column with the post\'s own asset id', async () => {
  const { pool, calls } = createMockPool(({ sql }) => {
    if (sql.includes('INSERT INTO posts')) return { rows: [{ id: '900' }] };
    return { rows: [] };
  });

  await persistPublishedPost(
    {
      tenantId: 15,
      jobId: 'mkt_weekly',
      caption: 'weekly post',
      platformPostId: '123_456',
      publishedAt: new Date('2026-05-20T10:00:00Z'),
      publishedStatus: 'published',
      platform: 'instagram',
      creativeAssetIds: ['img_2'],
    },
    pool,
  );

  const insert = calls.find((c) => c.sql.includes('INSERT INTO posts'));
  assert.ok(insert, 'expected INSERT INTO posts');
  assert.ok(
    insert.sql.includes('creative_asset_ids'),
    'INSERT must target the creative_asset_ids column',
  );
  assert.deepEqual(
    insert.params[CREATIVE_ASSET_IDS_PARAM_INDEX],
    ['img_2'],
    'creative_asset_ids param must carry the post\'s own asset id',
  );
});

test('persistPublishedPost defaults creative_asset_ids to an empty array when omitted', async () => {
  const { pool, calls } = createMockPool(({ sql }) => {
    if (sql.includes('INSERT INTO posts')) return { rows: [{ id: '901' }] };
    return { rows: [] };
  });

  await persistPublishedPost(
    {
      tenantId: 15,
      caption: 'caption-only post',
      platformPostId: '999_000',
      publishedAt: new Date('2026-05-20T11:00:00Z'),
      publishedStatus: 'published',
    },
    pool,
  );

  const insert = calls.find((c) => c.sql.includes('INSERT INTO posts'));
  assert.ok(insert, 'expected INSERT INTO posts');
  assert.deepEqual(
    insert.params[CREATIVE_ASSET_IDS_PARAM_INDEX],
    [],
    'omitted creative_asset_ids must insert an empty array (the column default), not null',
  );
});

test('persistPublishedPost normalizes blanks and duplicates out of creative_asset_ids', async () => {
  const { pool, calls } = createMockPool(({ sql }) => {
    if (sql.includes('INSERT INTO posts')) return { rows: [{ id: '902' }] };
    return { rows: [] };
  });

  await persistPublishedPost(
    {
      tenantId: 15,
      caption: 'post',
      platformPostId: '111_222',
      publishedAt: new Date('2026-05-20T12:00:00Z'),
      publishedStatus: 'published',
      creativeAssetIds: ['img_1', ' img_1 ', '', '   ', 'img_3'],
    },
    pool,
  );

  const insert = calls.find((c) => c.sql.includes('INSERT INTO posts'));
  assert.ok(insert);
  assert.deepEqual(
    insert.params[CREATIVE_ASSET_IDS_PARAM_INDEX],
    ['img_1', 'img_3'],
    'creative_asset_ids must be trimmed, de-duplicated, and free of blank entries',
  );
});

test('runPublishVerification threads creativeAssetIds into the posts INSERT', async () => {
  const { pool, calls } = createMockPool(({ sql }) => {
    if (sql.includes('INSERT INTO posts')) return { rows: [{ id: '903' }] };
    if (sql.includes('UPDATE posts')) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });

  const result = await runPublishVerification({
    tenantId: '15',
    provider: 'instagram',
    caption: 'weekly creative',
    primaryOutput: { platform_post_id: '321_654' },
    pool,
    jobId: 'mkt_weekly',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ id: '321_654' }), { status: 200 })) as typeof fetch,
    pageTokenLookup: async () => 'page-token-fixture',
    creativeAssetIds: ['5ef96782-5bf6-48b6-bb2e-8adb03a70e60'],
  });

  assert.equal(result.status, 'published');
  const insert = calls.find((c) => c.sql.includes('INSERT INTO posts'));
  assert.ok(insert, 'expected INSERT INTO posts');
  assert.deepEqual(
    insert.params[CREATIVE_ASSET_IDS_PARAM_INDEX],
    ['5ef96782-5bf6-48b6-bb2e-8adb03a70e60'],
    'runPublishVerification must pass creativeAssetIds through to the posts row',
  );
});

// End-to-end: a post written by the pipeline path (with creative_asset_ids
// populated) resolves to ONLY its own image, not the whole job's images.
test('a pipeline-created post resolves post-scoped media, not job-scoped', async () => {
  process.env.APP_BASE_URL = 'https://aries.example.test';

  // Two posts of one weekly job, each persisted with its own asset id — the
  // exact shape persistPublishedPost now writes.
  const posts = [
    { id: '100', tenant_id: '15', job_id: 'mkt_weekly', creative_asset_ids: ['img_1'] },
    { id: '200', tenant_id: '15', job_id: 'mkt_weekly', creative_asset_ids: ['img_2'] },
  ];
  const assets = [
    {
      id: 'asset-uuid-1',
      tenant_id: '15',
      source_job_id: 'mkt_weekly',
      source_asset_id: 'img_1',
      storage_key: '/home/node/.hermes/cache/images/post-one.png',
      storage_kind: 'runtime_asset',
      served_asset_ref: '/api/internal/hermes/media/post-one.png',
      orphaned_at: null,
    },
    {
      id: 'asset-uuid-2',
      tenant_id: '15',
      source_job_id: 'mkt_weekly',
      source_asset_id: 'img_2',
      storage_key: '/home/node/.hermes/cache/images/post-two.png',
      storage_kind: 'runtime_asset',
      served_asset_ref: '/api/internal/hermes/media/post-two.png',
      orphaned_at: null,
    },
  ];

  const db: DispatchQueryable = {
    query: async <T = Record<string, unknown>>(_sql: string, params: unknown[]) => {
      const [postId, tenantId] = params as [string, string];
      const post = posts.find((p) => p.id === postId && p.tenant_id === tenantId);
      if (!post) return { rows: [] as T[], rowCount: 0 };
      const ids = post.creative_asset_ids;
      const hasPerPostIds = Array.isArray(ids) && ids.length > 0;
      const matched = assets
        .filter((a) => {
          if (a.tenant_id !== tenantId) return false;
          if (a.orphaned_at !== null) return false;
          if (hasPerPostIds) {
            return ids.includes(a.id) || ids.includes(a.source_asset_id);
          }
          return a.source_job_id === post.job_id;
        })
        .map((a) => ({
          storage_key: a.storage_key,
          storage_kind: a.storage_kind,
          served_asset_ref: a.served_asset_ref,
        }));
      return { rows: matched as unknown as T[], rowCount: matched.length };
    },
  };

  const urlsA = await resolveMediaUrls('100', '15', db);
  assert.equal(urlsA.length, 1, 'post 100 resolves exactly one asset');
  assert.equal(
    urlsA[0],
    'https://aries.example.test/api/internal/hermes/media/post-one.png',
    'post 100 resolves its own image',
  );

  const urlsB = await resolveMediaUrls('200', '15', db);
  assert.equal(urlsB.length, 1, 'post 200 resolves exactly one asset');
  assert.equal(
    urlsB[0],
    'https://aries.example.test/api/internal/hermes/media/post-two.png',
    'post 200 resolves its own image, never post 100\'s',
  );
});
