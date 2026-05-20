import assert from 'node:assert/strict';
import test from 'node:test';

import pool from '../lib/db';
import { publishToMetaGraph, MetaPublishError, waitForInstagramContainerReady } from '../backend/integrations/meta-publishing';
import { encryptOAuthSecret } from '../backend/integrations/oauth-token-crypto';

type QueryResultRow = {
  access_token_enc: string | null;
  connection_id: string;
  external_account_id: string | null;
};

function installOauthQueryFixture(row: QueryResultRow) {
  const originalQuery = pool.query.bind(pool);
  (pool as typeof pool & { query: typeof pool.query }).query = (async () => ({
    rows: [row],
    rowCount: 1,
    command: 'SELECT',
    oid: 0,
    fields: [],
  })) as unknown as typeof pool.query;
  return () => {
    (pool as typeof pool & { query: typeof pool.query }).query = originalQuery;
  };
}

test('publishToMetaGraph publishes a Facebook post with uploaded media', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_1',
    external_account_id: 'page_123',
  });

  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, method, body });

    if (url.includes('/photos')) {
      return new Response(JSON.stringify({ id: 'media_001' }), { status: 200 });
    }
    if (url.includes('/feed')) {
      assert.match(body ?? '', /message=Ship\+it/);
      assert.match(body ?? '', /attached_media%5B0%5D=/);
      return new Response(JSON.stringify({ id: 'post_123' }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    const result = await publishToMetaGraph({
      tenantId: '12',
      provider: 'facebook',
      content: 'Ship it',
      mediaUrls: ['https://cdn.example.com/image.png'],
      fetchImpl: fetchImpl as typeof fetch,
    });

    assert.equal(result.provider, 'facebook');
    assert.equal(result.mode, 'live');
    assert.equal(result.platformPostId, 'post_123');
    assert.equal(calls.length, 2);
    assert.match(calls[0]?.url ?? '', /\/page_123\/photos$/);
    assert.match(calls[1]?.url ?? '', /\/page_123\/feed$/);
  } finally {
    restoreQuery();
  }
});

test('publishToMetaGraph schedules a Facebook post natively when scheduled_for is future-dated', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_2',
    external_account_id: 'page_456',
  });

  const scheduledFor = '2026-06-01T15:00:00.000Z';
  const calls: Array<{ url: string; body: string | null }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, body });
    return new Response(JSON.stringify({ id: 'scheduled_123' }), { status: 200 });
  };

  try {
    const result = await publishToMetaGraph({
      tenantId: '12',
      provider: 'meta',
      content: 'Scheduled hello',
      mediaUrls: [],
      scheduledFor,
      fetchImpl: fetchImpl as typeof fetch,
    });

    assert.equal(result.provider, 'facebook');
    assert.equal(result.mode, 'scheduled');
    assert.equal(result.scheduledFor, scheduledFor);
    assert.match(calls[0]?.body ?? '', /published=false/);
    assert.match(calls[0]?.body ?? '', /scheduled_publish_time=/);
  } finally {
    restoreQuery();
  }
});

test('publishToMetaGraph publishes an Instagram image post through container + poll + publish endpoints', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-page-token'),
    connection_id: 'conn_ig_1',
    external_account_id: 'ig_789',
  });

  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, method, body });
    if (url.includes('/media_publish')) {
      assert.match(body ?? '', /creation_id=container_001/);
      return new Response(JSON.stringify({ id: 'ig_post_001' }), { status: 200 });
    }
    // Container status poll (GET on the container id)
    if (method === 'GET' && url.includes('container_001') && url.includes('status_code')) {
      return new Response(JSON.stringify({ id: 'container_001', status_code: 'FINISHED' }), { status: 200 });
    }
    if (url.includes('/media')) {
      assert.match(body ?? '', /image_url=https%3A%2F%2Fcdn.example.com%2Fig.png/);
      return new Response(JSON.stringify({ id: 'container_001' }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    const result = await publishToMetaGraph({
      tenantId: '12',
      provider: 'instagram',
      content: 'Instagram hello',
      mediaUrls: ['https://cdn.example.com/ig.png'],
      fetchImpl: fetchImpl as typeof fetch,
    });

    assert.equal(result.provider, 'instagram');
    assert.equal(result.mode, 'live');
    assert.equal(result.platformPostId, 'ig_post_001');
    // Calls: create container, status poll, media_publish
    assert.equal(calls.length, 3);
    const pollCall = calls.find((c) => c.method === 'GET' && c.url.includes('container_001'));
    assert.ok(pollCall, 'container readiness poll must have been made');
  } finally {
    restoreQuery();
  }
});

test('publishToMetaGraph blocks Instagram scheduled publishing with a safe fallback error', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-page-token'),
    connection_id: 'conn_ig_2',
    external_account_id: 'ig_900',
  });

  try {
    await assert.rejects(
      () => publishToMetaGraph({
        tenantId: '12',
        provider: 'instagram',
        content: 'Not yet',
        mediaUrls: ['https://cdn.example.com/ig.png'],
        scheduledFor: '2026-06-01T15:00:00.000Z',
        fetchImpl: (async () => {
          throw new Error('fetch must not be called');
        }) as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        const publishError = error as MetaPublishError;
        assert.equal(publishError.code, 'instagram_scheduled_publish_not_supported');
        assert.equal(publishError.status, 409);
        return true;
      },
    );
  } finally {
    restoreQuery();
  }
});

// ---- waitForInstagramContainerReady unit tests ----

function makeDummyTarget() {
  return {
    provider: 'instagram' as const,
    accessToken: 'test-token',
    connectionId: 'conn_test',
    externalAccountId: 'ig_test',
  };
}

const noSleep = async (_ms: number) => {};

test('waitForInstagramContainerReady resolves after IN_PROGRESS x2 then FINISHED', async () => {
  const statusSequence = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
  let pollCount = 0;
  const fetchImpl = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const status = statusSequence[pollCount] ?? 'FINISHED';
    pollCount += 1;
    return new Response(JSON.stringify({ id: 'c_001', status_code: status }), { status: 200 });
  };

  await waitForInstagramContainerReady({
    target: makeDummyTarget(),
    creationId: 'c_001',
    fetchImpl: fetchImpl as typeof fetch,
    sleepImpl: noSleep,
  });

  assert.equal(pollCount, 3, 'should poll three times before FINISHED');
});

test('waitForInstagramContainerReady throws instagram_container_failed on ERROR status', async () => {
  const fetchImpl = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify({ id: 'c_002', status_code: 'ERROR' }), { status: 200 });
  };

  await assert.rejects(
    () => waitForInstagramContainerReady({
      target: makeDummyTarget(),
      creationId: 'c_002',
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: noSleep,
    }),
    (error: unknown) => {
      assert.ok(error instanceof MetaPublishError);
      assert.equal((error as MetaPublishError).code, 'instagram_container_failed');
      assert.equal((error as MetaPublishError).status, 422);
      assert.equal((error as MetaPublishError).retryable, false);
      return true;
    },
  );
});

test('waitForInstagramContainerReady throws instagram_container_timeout when never FINISHED', async () => {
  const fetchImpl = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify({ id: 'c_003', status_code: 'IN_PROGRESS' }), { status: 200 });
  };

  await assert.rejects(
    () => waitForInstagramContainerReady({
      target: makeDummyTarget(),
      creationId: 'c_003',
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: noSleep,
    }),
    (error: unknown) => {
      assert.ok(error instanceof MetaPublishError);
      assert.equal((error as MetaPublishError).code, 'instagram_container_timeout');
      assert.equal((error as MetaPublishError).status, 504);
      assert.equal((error as MetaPublishError).retryable, true);
      return true;
    },
  );
});
