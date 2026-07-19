import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import {
  extractPlatformPostId,
  persistPublishedPost,
  runPublishVerification,
  verifyMetaPostExists,
} from '../backend/integrations/publish-verification';
import {
  backfillInsightsAttribution,
  type BackfillQueryable,
} from '../scripts/backfill-insights-attribution';

type QueryArgs = { sql: string; params: unknown[] };

interface QueryHandler {
  (args: QueryArgs): { rows: unknown[]; rowCount?: number };
}

function createMockPool(handler: QueryHandler): { pool: Pool; calls: QueryArgs[] } {
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

test('extractPlatformPostId: pulls id from primaryOutput.platform_post_id', () => {
  const result = extractPlatformPostId({ platform_post_id: '123456_789012' });
  assert.equal(result, '123456_789012');
});

test('extractPlatformPostId: pulls id from primaryOutput.post_id fallback', () => {
  const result = extractPlatformPostId({ post_id: '987654_321098' });
  assert.equal(result, '987654_321098');
});

test('extractPlatformPostId: pulls id from primaryOutput.id fallback', () => {
  const result = extractPlatformPostId({ id: '555_444' });
  assert.equal(result, '555_444');
});

test('extractPlatformPostId: returns null on missing id', () => {
  assert.equal(extractPlatformPostId({}), null);
  assert.equal(extractPlatformPostId(null), null);
  assert.equal(extractPlatformPostId(undefined), null);
});

test('extractPlatformPostId: rejects empty / non-string ids', () => {
  assert.equal(extractPlatformPostId({ platform_post_id: '' }), null);
  assert.equal(extractPlatformPostId({ platform_post_id: '   ' }), null);
  assert.equal(extractPlatformPostId({ platform_post_id: 12345 }), null);
});

test('verifyMetaPostExists: HTTP 200 with matching id is verified', async () => {
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.ok(url.startsWith('https://graph.facebook.com/'), `unexpected url: ${url}`);
    assert.ok(url.includes('123_456'));
    assert.ok(url.includes('access_token=page-token'));
    return new Response(JSON.stringify({ id: '123_456' }), { status: 200 });
  };
  const result = await verifyMetaPostExists({
    platformPostId: '123_456',
    pageToken: 'page-token',
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(result.verified, true);
});

test('verifyMetaPostExists: HTTP 404 is unverified', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
  const result = await verifyMetaPostExists({
    platformPostId: '123_456',
    pageToken: 'page-token',
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'graph_404');
});

test('verifyMetaPostExists: HTTP 5xx is unverified (transient)', async () => {
  const fetchImpl = async () => new Response('boom', { status: 502 });
  const result = await verifyMetaPostExists({
    platformPostId: '123_456',
    pageToken: 'page-token',
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'graph_5xx');
});

test('verifyMetaPostExists: network error is unverified', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const result = await verifyMetaPostExists({
    platformPostId: '123_456',
    pageToken: 'page-token',
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'graph_network_error');
});

test('verifyMetaPostExists: id mismatch is unverified', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ id: 'other_id' }), { status: 200 });
  const result = await verifyMetaPostExists({
    platformPostId: '123_456',
    pageToken: 'page-token',
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'graph_id_mismatch');
});

test('persistPublishedPost: inserts published row using caption column', async () => {
  const { pool, calls } = createMockPool(({ sql }) => {
    if (sql.includes('INSERT INTO posts')) {
      return { rows: [{ id: '42' }] };
    }
    return { rows: [] };
  });
  const result = await persistPublishedPost(
    {
      tenantId: 7,
      caption: 'hello world',
      platformPostId: '123_456',
      publishedAt: new Date('2026-05-06T10:00:00Z'),
      publishedStatus: 'published',
    },
    pool,
  );
  assert.equal(result.postId, '42');
  assert.ok(calls.length >= 1, 'expected at least one query');
  const insert = calls.find((c) => c.sql.includes('INSERT INTO posts'));
  assert.ok(insert, 'expected INSERT INTO posts');
  // INSERT order: tenant_id, job_id, caption, platform_post_id, ...
  assert.ok(insert?.sql.includes('caption'), 'SQL must reference caption column, not content');
  assert.ok(!insert?.sql.includes('content'), 'SQL must NOT reference content column');
  assert.ok(insert?.sql.includes('job_id'), 'SQL must include job_id column');
  assert.equal(insert?.params[0], 7, 'tenant_id param');
  assert.equal(insert?.params[2], 'hello world', 'caption param');
  assert.equal(insert?.params[3], '123_456', 'platform_post_id param');
});

test('persistPublishedPost: includes job_id in insert when provided', async () => {
  const { pool, calls } = createMockPool(({ sql }) => {
    if (sql.includes('INSERT INTO posts')) {
      return { rows: [{ id: '55' }] };
    }
    return { rows: [] };
  });
  await persistPublishedPost(
    {
      tenantId: 7,
      caption: 'campaign caption',
      platformPostId: '123_456',
      publishedAt: new Date('2026-05-06T10:00:00Z'),
      publishedStatus: 'published',
      jobId: 'mkt_abc123',
    },
    pool,
  );
  const insert = calls.find((c) => c.sql.includes('INSERT INTO posts'));
  assert.ok(insert, 'expected INSERT INTO posts');
  // job_id is params[1]
  assert.equal(insert?.params[1], 'mkt_abc123', 'job_id param should be the marketing job id');
});

test('persistPublishedPost: writes unverified status when requested', async () => {
  const { pool, calls } = createMockPool(({ sql }) => {
    if (sql.includes('INSERT INTO posts')) {
      return { rows: [{ id: '101' }] };
    }
    return { rows: [] };
  });
  await persistPublishedPost(
    {
      tenantId: 9,
      caption: 'unverified post',
      platformPostId: '999_888',
      publishedAt: new Date('2026-05-06T11:00:00Z'),
      publishedStatus: 'unverified',
    },
    pool,
  );
  const insert = calls.find((c) => c.sql.includes('INSERT INTO posts'));
  assert.ok(insert);
  // published_status is now params[5] (tenant_id, job_id, caption, platform_post_id, published_at, published_status)
  assert.equal(insert?.params[5], 'unverified', 'published_status param should be unverified');
});

test('persistPublishedPost: repairs a null idempotent platform id before best-effort stamping so later backfill can attribute it', async () => {
  const sourcePost = {
    id: '901',
    tenantId: 7,
    platform: 'facebook',
    idempotencyKey: 'publish:retry:1',
    platformPostId: null as string | null,
  };
  const insight = {
    id: '501',
    tenantId: 7,
    platform: 'facebook',
    externalPostId: 'fb_retry_901',
    ariesPostId: null as string | null,
  };
  let insightHasSynced = false;

  const { pool, calls } = createMockPool(({ sql, params }) => {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
    if (normalizedSql.startsWith('SELECT id, platform_post_id FROM posts')) {
      return { rows: [{ id: sourcePost.id, platform_post_id: sourcePost.platformPostId }] };
    }
    if (normalizedSql.startsWith('UPDATE posts SET platform_post_id')) {
      assert.match(normalizedSql, /WHERE id = \$2/);
      assert.match(normalizedSql, /tenant_id = \$3/);
      assert.match(normalizedSql, /platform = \$4/);
      assert.match(normalizedSql, /idempotency_key = \$5/);
      assert.match(normalizedSql, /platform_post_id = COALESCE\(platform_post_id, \$1\)/);
      assert.deepEqual(params, [
        insight.externalPostId,
        sourcePost.id,
        sourcePost.tenantId,
        sourcePost.platform,
        sourcePost.idempotencyKey,
      ]);
      if (sourcePost.platformPostId !== null) return { rows: [], rowCount: 0 };
      sourcePost.platformPostId = String(params[0]);
      return { rows: [{ platform_post_id: sourcePost.platformPostId }], rowCount: 1 };
    }
    if (/UPDATE insights_posts/i.test(sql) && /external_post_id = \$4/i.test(sql)) {
      assert.equal(insightHasSynced, false, 'publish-time Insights stamp must tolerate a missing row');
      assert.equal(
        sourcePost.platformPostId,
        insight.externalPostId,
        'the durable source row must be repaired before the best-effort stamp runs',
      );
      return { rows: [], rowCount: 0 };
    }
    if (normalizedSql.startsWith('SELECT ip.id AS insights_post_id')) {
      const rows = insightHasSynced
        && insight.ariesPostId === null
        && sourcePost.platformPostId === insight.externalPostId
        ? [{
            insights_post_id: insight.id,
            tenant_id: insight.tenantId,
            aries_post_id: sourcePost.id,
          }]
        : [];
      return { rows };
    }
    if (/UPDATE insights_posts/i.test(sql) && /WHERE id = \$2/i.test(sql)) {
      insight.ariesPostId = String(params[0]);
      return { rows: [{ id: insight.id }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${normalizedSql}`);
  });

  const persisted = await persistPublishedPost(
    {
      tenantId: sourcePost.tenantId,
      caption: 'successful retry',
      platformPostId: insight.externalPostId,
      publishedAt: new Date('2026-07-19T20:00:00Z'),
      publishedStatus: 'published',
      platform: sourcePost.platform,
      idempotencyKey: sourcePost.idempotencyKey,
    },
    pool,
  );

  assert.deepEqual(persisted, { postId: sourcePost.id });
  assert.equal(sourcePost.platformPostId, insight.externalPostId);
  assert.ok(
    calls.some((call) => /UPDATE posts[\s\S]*platform_post_id\s*=\s*COALESCE/i.test(call.sql)),
    'the existing source row should be repaired before the best-effort Insights stamp',
  );

  insightHasSynced = true;
  const report = await backfillInsightsAttribution(pool as unknown as BackfillQueryable, {
    tenantId: sourcePost.tenantId,
    write: true,
    log: () => {},
  });

  assert.deepEqual(report, { mode: 'write', candidates: 1, updated: 1, batches: 1 });
  assert.equal(insight.ariesPostId, sourcePost.id);
});

test('persistPublishedPost: repairs a null platform id in the concurrent-insert fallback', async () => {
  const sourcePost = {
    id: '902',
    tenantId: 7,
    platform: 'instagram',
    idempotencyKey: 'publish:retry:2',
    platformPostId: null as string | null,
  };
  let lookupCount = 0;

  const { pool, calls } = createMockPool(({ sql, params }) => {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
    if (normalizedSql.startsWith('SELECT id, platform_post_id FROM posts')) {
      lookupCount += 1;
      return lookupCount === 1
        ? { rows: [] }
        : { rows: [{ id: sourcePost.id, platform_post_id: sourcePost.platformPostId }] };
    }
    if (normalizedSql.startsWith('INSERT INTO posts')) {
      return { rows: [], rowCount: 0 };
    }
    if (normalizedSql.startsWith('UPDATE posts SET platform_post_id')) {
      assert.deepEqual(params, [
        'ig_retry_902',
        sourcePost.id,
        sourcePost.tenantId,
        sourcePost.platform,
        sourcePost.idempotencyKey,
      ]);
      sourcePost.platformPostId = String(params[0]);
      return { rows: [{ platform_post_id: sourcePost.platformPostId }], rowCount: 1 };
    }
    if (/UPDATE insights_posts/i.test(sql)) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected query: ${normalizedSql}`);
  });

  const result = await persistPublishedPost(
    {
      tenantId: sourcePost.tenantId,
      caption: 'concurrent retry',
      platformPostId: 'ig_retry_902',
      publishedAt: new Date('2026-07-19T20:05:00Z'),
      publishedStatus: 'published',
      platform: sourcePost.platform,
      idempotencyKey: sourcePost.idempotencyKey,
    },
    pool,
  );

  assert.deepEqual(result, { postId: sourcePost.id });
  assert.equal(sourcePost.platformPostId, 'ig_retry_902');
  assert.equal(lookupCount, 2);
  assert.equal(calls.filter((call) => /UPDATE posts[\s\S]*platform_post_id\s*=\s*COALESCE/i.test(call.sql)).length, 1);
});

test('persistPublishedPost: never overwrites an existing non-null platform id', async () => {
  let stampedPlatformPostId: unknown;
  const { pool, calls } = createMockPool(({ sql, params }) => {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
    if (normalizedSql.startsWith('SELECT id, platform_post_id FROM posts')) {
      return { rows: [{ id: '903', platform_post_id: 'first_writer_wins' }] };
    }
    if (normalizedSql.startsWith('UPDATE posts SET platform_post_id')) {
      throw new Error('must not attempt to replace a non-null platform_post_id');
    }
    if (/UPDATE insights_posts/i.test(sql)) {
      stampedPlatformPostId = params[3];
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query: ${normalizedSql}`);
  });

  const result = await persistPublishedPost(
    {
      tenantId: 7,
      caption: 'duplicate retry',
      platformPostId: 'later_retry_id',
      publishedAt: new Date('2026-07-19T20:10:00Z'),
      publishedStatus: 'published',
      platform: 'facebook',
      idempotencyKey: 'publish:retry:3',
    },
    pool,
  );

  assert.deepEqual(result, { postId: '903' });
  assert.equal(stampedPlatformPostId, 'first_writer_wins');
  assert.equal(calls.filter((call) => /UPDATE posts SET platform_post_id/i.test(call.sql)).length, 0);
});

test('runPublishVerification: happy path persists published + verifies', async () => {
  const { pool, calls } = createMockPool(({ sql }) => {
    if (sql.includes('INSERT INTO posts')) {
      return { rows: [{ id: '777' }] };
    }
    if (sql.includes('UPDATE posts')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  });

  let fetchedUrl = '';
  const fetchImpl = async (input: RequestInfo | URL) => {
    fetchedUrl = String(input);
    return new Response(JSON.stringify({ id: '123_456' }), { status: 200 });
  };

  const result = await runPublishVerification({
    tenantId: '5',
    provider: 'meta',
    caption: 'hello world',
    primaryOutput: { platform_post_id: '123_456' },
    pool,
    fetchImpl: fetchImpl as typeof fetch,
    pageTokenLookup: async () => 'page-token-fixture',
  });

  assert.equal(result.status, 'published');
  assert.equal(result.platformPostId, '123_456');
  assert.equal(result.postId, '777');
  assert.ok(result.publishedAt && /^\d{4}-\d{2}-\d{2}T/.test(result.publishedAt), 'publishedAt ISO');
  assert.ok(fetchedUrl.includes('123_456'));
  assert.ok(calls.some((c) => c.sql.includes('INSERT INTO posts')), 'INSERT runs first to claim the row');
  assert.ok(calls.some((c) => c.sql.includes('UPDATE posts')), 'UPDATE bumps status to published after verification');
});

test('runPublishVerification: 404 path persists unverified', async () => {
  const { pool, calls } = createMockPool(({ sql }) => {
    if (sql.includes('INSERT INTO posts')) {
      return { rows: [{ id: '778' }] };
    }
    return { rows: [] };
  });
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });

  const result = await runPublishVerification({
    tenantId: '5',
    provider: 'meta',
    caption: 'hello',
    primaryOutput: { platform_post_id: 'doesnt_exist' },
    pool,
    fetchImpl: fetchImpl as typeof fetch,
    pageTokenLookup: async () => 'page-token-fixture',
  });

  assert.equal(result.status, 'unverified');
  assert.equal(result.platformPostId, 'doesnt_exist');
  assert.equal(result.reason, 'graph_404');
  assert.ok(result.publishedAt && /^\d{4}-\d{2}-\d{2}T/.test(result.publishedAt));
  const insert = calls.find((c) => c.sql.includes('INSERT INTO posts'));
  assert.ok(insert);
  // params: [tenant_id, job_id, caption, platform_post_id, published_at, published_status, ...]
  assert.equal(insert?.params[5], 'unverified', 'persisted row carries unverified status');
});

test('runPublishVerification: missing page token marks unverified', async () => {
  const { pool, calls } = createMockPool(({ sql }) => {
    if (sql.includes('INSERT INTO posts')) {
      return { rows: [{ id: '779' }] };
    }
    return { rows: [] };
  });

  const result = await runPublishVerification({
    tenantId: '5',
    provider: 'meta',
    caption: 'no token',
    primaryOutput: { platform_post_id: '999' },
    pool,
    fetchImpl: (async () => {
      throw new Error('fetch should not be called when token missing');
    }) as typeof fetch,
    pageTokenLookup: async () => null,
  });

  assert.equal(result.status, 'unverified');
  assert.equal(result.reason, 'page_token_unavailable');
  assert.ok(result.publishedAt && /^\d{4}-\d{2}-\d{2}T/.test(result.publishedAt));
  const insert = calls.find((c) => c.sql.includes('INSERT INTO posts'));
  assert.ok(insert);
  // params: [tenant_id, job_id, caption, platform_post_id, published_at, published_status, ...]
  assert.equal(insert?.params[5], 'unverified');
});

test('runPublishVerification: missing platform_post_id returns skipped', async () => {
  const { pool, calls } = createMockPool(() => ({ rows: [] }));

  const result = await runPublishVerification({
    tenantId: '5',
    provider: 'meta',
    caption: 'no id',
    primaryOutput: { irrelevant: true },
    pool,
    fetchImpl: (async () => {
      throw new Error('should not call');
    }) as typeof fetch,
    pageTokenLookup: async () => 'page-token',
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.platformPostId, null);
  assert.equal(result.publishedAt, null);
  assert.equal(calls.length, 0, 'should not write or fetch when no id');
});

test('runPublishVerification: non-meta providers are skipped (verification is meta-only in v1)', async () => {
  const { pool, calls } = createMockPool(() => ({ rows: [] }));

  const result = await runPublishVerification({
    tenantId: '5',
    provider: 'linkedin',
    caption: 'linkedin post',
    primaryOutput: { platform_post_id: 'urn:li:activity:123' },
    pool,
    fetchImpl: (async () => {
      throw new Error('should not call meta graph for non-meta provider');
    }) as typeof fetch,
    pageTokenLookup: async () => null,
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.publishedAt, null);
  assert.equal(calls.length, 0);
});
