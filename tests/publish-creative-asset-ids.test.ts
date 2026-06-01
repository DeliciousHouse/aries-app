import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import type { Pool } from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';

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

// ---------------------------------------------------------------------------
// Real-Postgres integration test.
//
// The mock tests above prove query construction, but a mock pool never
// validates SQL or schema — it cannot prove `posts.creative_asset_ids` exists,
// accepts a text[], or that the REAL resolveMediaUrls SQL scopes per-post. This
// test runs the actual `persistPublishedPost` INSERT and the actual
// `resolveMediaUrls` SELECT against the live schema. Every statement runs
// inside a transaction that is ALWAYS rolled back, so nothing persists.
//
// When DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME are absent the test skips
// loudly. When the DB is reachable it MUST run and pass.
// ---------------------------------------------------------------------------

function dbConfigFromEnv(): pg.PoolConfig | null {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_USER || !DB_PASSWORD || !DB_NAME) {
    return null;
  }
  return {
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    max: 2,
  };
}

const dbConfig = dbConfigFromEnv();

test('creative_asset_ids round-trips through the real posts schema and resolver', async (t) => {
  if (!dbConfig) {
    console.warn(
      '\n[publish-creative-asset-ids-live-db] SKIPPED: DB_HOST/DB_PORT/DB_USER/' +
        'DB_PASSWORD/DB_NAME not all set. This test MUST run against a real ' +
        'database in CI/prod validation — a skip means the live posts schema ' +
        'and the real resolveMediaUrls SQL were never exercised.\n',
    );
    requireDbEnvOrSkip(t);
    return;
  }

  process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'https://aries.example.test';

  const pool = new pg.Pool(dbConfig);
  const JOB_ID = `test_cai_${Date.now()}`;

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // posts.tenant_id and creative_assets.tenant_id both FK to
      // organizations(id), so seeded rows need a real org id. Resolve one
      // dynamically — nothing is hardcoded and the whole transaction is rolled
      // back, so no row ever persists under that org.
      const orgRow = await client.query<{ id: number }>(
        'SELECT id FROM organizations ORDER BY id LIMIT 1',
      );
      assert.ok(orgRow.rows.length === 1, 'live DB must have at least one organization to FK against');
      const TENANT_ID = orgRow.rows[0].id;
      const TENANT_STR = String(TENANT_ID);

      // 1. The real persistPublishedPost INSERT against the live posts table.
      //    A single-client transaction-scoped Pool shim so persistPublishedPost
      //    writes inside this rolled-back transaction.
      const txPool = {
        query: (sql: string, params: unknown[]) => client.query(sql, params),
      } as unknown as Pool;

      const persisted = await persistPublishedPost(
        {
          tenantId: TENANT_ID,
          jobId: JOB_ID,
          caption: 'live-db creative_asset_ids test',
          platformPostId: 'live_111_222',
          publishedAt: new Date(),
          publishedStatus: 'published',
          platform: 'instagram',
          creativeAssetIds: ['img_1'],
        },
        txPool,
      );

      // 2. SELECT the row back — proves the column exists and stored the text[].
      const back = await client.query<{ creative_asset_ids: string[] }>(
        'SELECT creative_asset_ids FROM posts WHERE id = $1',
        [persisted.postId],
      );
      assert.equal(back.rows.length, 1, 'persisted posts row must be readable');
      assert.deepEqual(
        back.rows[0].creative_asset_ids,
        ['img_1'],
        'live posts.creative_asset_ids must store the text[] persistPublishedPost wrote',
      );

      // 3. Seed two posts of one job, each with its own creative_asset, plus a
      //    third post with empty creative_asset_ids, then run the REAL
      //    resolveMediaUrls SQL.
      const postA = await client.query<{ id: string }>(
        `INSERT INTO posts (tenant_id, job_id, caption, platform, creative_asset_ids)
         VALUES ($1, $2, 'post A', 'instagram', $3) RETURNING id`,
        [TENANT_ID, JOB_ID, ['img_1']],
      );
      const postB = await client.query<{ id: string }>(
        `INSERT INTO posts (tenant_id, job_id, caption, platform, creative_asset_ids)
         VALUES ($1, $2, 'post B', 'instagram', $3) RETURNING id`,
        [TENANT_ID, JOB_ID, ['img_2']],
      );
      const postEmpty = await client.query<{ id: string }>(
        `INSERT INTO posts (tenant_id, job_id, caption, platform, creative_asset_ids)
         VALUES ($1, $2, 'post empty', 'instagram', '{}') RETURNING id`,
        [TENANT_ID, JOB_ID],
      );

      // Two runtime_asset rows of the same job, distinct source_asset_ids.
      await client.query(
        `INSERT INTO creative_assets
           (tenant_id, source_type, permission_scope, media_type,
            source_job_id, source_asset_id, storage_kind, storage_key, served_asset_ref)
         VALUES
           ($1, 'generated_by_aries', 'generated', 'image', $2, 'img_1',
            'runtime_asset', '/host/path/a.png', '/api/internal/hermes/media/live-a.png'),
           ($1, 'generated_by_aries', 'generated', 'image', $2, 'img_2',
            'runtime_asset', '/host/path/b.png', '/api/internal/hermes/media/live-b.png')`,
        [TENANT_ID, JOB_ID],
      );

      const resolverDb = {
        query: (sql: string, params: unknown[]) => client.query(sql, params),
      } as unknown as DispatchQueryable;

      // Post A: per-post link to img_1 -> only asset A.
      const urlsA = await resolveMediaUrls(postA.rows[0].id, TENANT_STR, resolverDb);
      assert.deepEqual(
        urlsA,
        [`${process.env.APP_BASE_URL}/api/internal/hermes/media/live-a.png`],
        'post A must resolve ONLY its own asset via creative_asset_ids',
      );

      // Post B: per-post link to img_2 -> only asset B.
      const urlsB = await resolveMediaUrls(postB.rows[0].id, TENANT_STR, resolverDb);
      assert.deepEqual(
        urlsB,
        [`${process.env.APP_BASE_URL}/api/internal/hermes/media/live-b.png`],
        'post B must resolve ONLY its own asset, never post A\'s',
      );

      // Post with empty creative_asset_ids: falls back to job-scope -> both.
      const urlsEmpty = await resolveMediaUrls(postEmpty.rows[0].id, TENANT_STR, resolverDb);
      assert.equal(
        urlsEmpty.length,
        2,
        'empty creative_asset_ids must fall back to the job-scoped join (both job assets)',
      );

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    console.log(
      '[publish-creative-asset-ids-live-db] PASS: persistPublishedPost wrote ' +
        'creative_asset_ids to the live posts schema and the real ' +
        'resolveMediaUrls SQL scoped media per-post (with job-scope fallback).',
    );
  } finally {
    await pool.end();
  }
});
