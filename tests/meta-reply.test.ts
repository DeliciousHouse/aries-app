import assert from 'node:assert/strict';
import test from 'node:test';

import pool from '../lib/db';
import { replyToComment } from '../backend/integrations/meta-reply';
import { MetaPublishError } from '../backend/integrations/meta-publishing';
import { encryptOAuthSecret } from '../backend/integrations/oauth-token-crypto';

type QueryResultRow = {
  access_token_enc: string | null;
  connection_id: string;
  external_account_id: string | null;
};

// Monkeypatch the shared pool's oauth-token query, exactly like
// tests/meta-publishing.test.ts. `null` simulates a tenant with no connected
// token row.
function installOauthQueryFixture(row: QueryResultRow | null) {
  const originalQuery = pool.query.bind(pool);
  (pool as typeof pool & { query: typeof pool.query }).query = (async () => ({
    rows: row ? [row] : [],
    rowCount: row ? 1 : 0,
    command: 'SELECT',
    oid: 0,
    fields: [],
  })) as unknown as typeof pool.query;
  return () => {
    (pool as typeof pool & { query: typeof pool.query }).query = originalQuery;
  };
}

type Call = { url: string; method: string; body: string | null };

function recordingFetch(calls: Call[], response: () => Response) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return response();
  }) as typeof fetch;
}

test('replyToComment posts an Instagram reply to /{comment-id}/replies', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restore = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-token'),
    connection_id: 'conn_ig_reply',
    external_account_id: 'ig_acct',
  });
  const calls: Call[] = [];
  const fetchImpl = recordingFetch(calls, () => new Response(JSON.stringify({ id: 'ig_reply_001' }), { status: 200 }));

  try {
    const result = await replyToComment({
      tenantId: '12',
      provider: 'instagram',
      externalCommentId: 'ig_comment_42',
      message: 'Thanks for the kind words!',
      fetchImpl,
    });

    assert.equal(result.provider, 'instagram');
    assert.equal(result.platformReplyId, 'ig_reply_001');
    assert.equal(result.connectionId, 'conn_ig_reply');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'POST');
    assert.match(calls[0]?.url ?? '', /\/ig_comment_42\/replies$/);
    assert.match(calls[0]?.body ?? '', /message=Thanks/);
    assert.match(calls[0]?.body ?? '', /access_token=/);
  } finally {
    restore();
  }
});

test('replyToComment posts a Facebook reply to /{comment-id}/comments (IG vs FB endpoint divergence)', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restore = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('fb-token'),
    connection_id: 'conn_fb_reply',
    external_account_id: 'page_acct',
  });
  const calls: Call[] = [];
  const fetchImpl = recordingFetch(calls, () => new Response(JSON.stringify({ id: 'fb_reply_001' }), { status: 200 }));

  try {
    const result = await replyToComment({
      tenantId: '12',
      provider: 'facebook',
      externalCommentId: 'fb_comment_7',
      message: 'Glad you like it',
      fetchImpl,
    });

    assert.equal(result.provider, 'facebook');
    assert.equal(result.platformReplyId, 'fb_reply_001');
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? '', /\/fb_comment_7\/comments$/);
    // The FB reply must NOT use the IG /replies edge.
    assert.ok(!(calls[0]?.url ?? '').includes('/replies'), 'FB reply must hit /comments, not /replies');
  } finally {
    restore();
  }
});

test('replyToComment surfaces a Graph 4xx as a definitely-never-posted MetaPublishError', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restore = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-token'),
    connection_id: 'conn_ig_fail',
    external_account_id: 'ig_acct',
  });
  const calls: Call[] = [];
  const fetchImpl = recordingFetch(calls, () =>
    new Response(JSON.stringify({ error: { message: 'Invalid parameter' } }), { status: 400 }),
  );

  try {
    await assert.rejects(
      () => replyToComment({
        tenantId: '12',
        provider: 'instagram',
        externalCommentId: 'ig_comment_42',
        message: 'will fail',
        fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        const e = error as MetaPublishError;
        assert.equal(e.code, 'graph_api_error');
        assert.equal(e.outcomeUnknown, false, 'a rejected reply POST is definitely-never-posted');
        return true;
      },
    );
    assert.equal(calls.length, 1, 'the reply POST was attempted exactly once');
  } finally {
    restore();
  }
});

test('replyToComment treats a 2xx reply with no id as outcome-unknown (never auto-retry)', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restore = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-token'),
    connection_id: 'conn_ig_unknown',
    external_account_id: 'ig_acct',
  });
  const calls: Call[] = [];
  const fetchImpl = recordingFetch(calls, () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

  try {
    await assert.rejects(
      () => replyToComment({
        tenantId: '12',
        provider: 'instagram',
        externalCommentId: 'ig_comment_42',
        message: 'accepted but unconfirmed',
        fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        const e = error as MetaPublishError;
        assert.equal(e.code, 'instagram_reply_missing_id');
        assert.equal(e.outcomeUnknown, true, 'a 2xx reply with no id is outcome-unknown');
        assert.equal(e.retryable, false, 'outcome-unknown must never auto-retry');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('replyToComment rejects a non-Meta provider (youtube) before any Graph call', async () => {
  const restore = installOauthQueryFixture(null);
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => replyToComment({
        tenantId: '12',
        provider: 'youtube',
        externalCommentId: 'yt_comment',
        message: 'hi',
        fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        assert.equal((error as MetaPublishError).code, 'unsupported_provider');
        assert.equal((error as MetaPublishError).status, 400);
        return true;
      },
    );
    assert.equal(fetchCalls, 0, 'no Graph call for an unsupported provider');
  } finally {
    restore();
  }
});

test('replyToComment rejects an empty message before any Graph call', async () => {
  const restore = installOauthQueryFixture(null);
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => replyToComment({
        tenantId: '12',
        provider: 'instagram',
        externalCommentId: 'ig_comment_42',
        message: '   ',
        fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        assert.equal((error as MetaPublishError).code, 'missing_reply_text');
        assert.equal((error as MetaPublishError).status, 400);
        return true;
      },
    );
    assert.equal(fetchCalls, 0, 'no Graph call for an empty message');
  } finally {
    restore();
  }
});

test('replyToComment rejects when the tenant has no connected token (no Graph call)', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restore = installOauthQueryFixture(null);
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => replyToComment({
        tenantId: '12',
        provider: 'instagram',
        externalCommentId: 'ig_comment_42',
        message: 'hi',
        fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        assert.equal((error as MetaPublishError).code, 'oauth_token_missing');
        assert.equal((error as MetaPublishError).status, 409);
        return true;
      },
    );
    assert.equal(fetchCalls, 0, 'no Graph call when the token is missing');
  } finally {
    restore();
  }
});
