import assert from 'node:assert/strict';
import test from 'node:test';

import pool from '../lib/db';
import { publishToMetaGraph, MetaPublishError } from '../backend/integrations/meta-publishing';
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

test('publishToMetaGraph publishes an Instagram image post through container + publish endpoints', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-page-token'),
    connection_id: 'conn_ig_1',
    external_account_id: 'ig_789',
  });

  const calls: Array<{ url: string; body: string | null }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, body });
    if (url.includes('/media_publish')) {
      assert.match(body ?? '', /creation_id=container_001/);
      return new Response(JSON.stringify({ id: 'ig_post_001' }), { status: 200 });
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
    assert.equal(calls.length, 2);
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
