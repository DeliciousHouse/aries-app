import assert from 'node:assert/strict';
import test from 'node:test';

import { POST } from '../app/api/internal/publishing/scheduled-dispatch/route';
import { encryptOAuthSecret } from '../backend/integrations/oauth-token-crypto';
import pool from '../lib/db';

type QueryCall = { sql: string; params: unknown[] };

type DispatchFixtureOptions = {
  owned: boolean;
  finalizeOwned?: boolean;
  insightExists?: boolean;
  providerPostId?: string;
};

function makeRequest(secret: string, attemptToken: string): Request {
  return new Request('https://aries.example.com/api/internal/publishing/scheduled-dispatch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      tenant_id: '15',
      post_id: '901',
      scheduled_post_id: '71',
      dispatch_attempt_token: attemptToken,
      platforms: ['facebook'],
      content: 'Owned scheduled dispatch',
      media_urls: ['https://cdn.example.com/post.jpg'],
      surface: 'feed',
      media_type: 'image',
    }),
  });
}

function installDispatchFixture(options: DispatchFixtureOptions) {
  const calls: QueryCall[] = [];
  let ariesPostId: string | null = null;
  const originalQuery = pool.query.bind(pool);
  const providerPostId = options.providerPostId ?? 'fb_canonical_901';

  (pool as typeof pool & { query: typeof pool.query }).query = (async (
    sql: unknown,
    params: unknown[] = [],
  ) => {
    const text = String(sql);
    calls.push({ sql: text, params });

    if (/^\s*SELECT 1 AS owned[\s\S]*FROM scheduled_posts/i.test(text)) {
      return { rows: options.owned ? [{ owned: 1 }] : [], rowCount: options.owned ? 1 : 0 };
    }
    if (/OAUTH_TOKENS|OAUTH_CONNECTIONS/i.test(text)) {
      return {
        rows: [{
          access_token_enc: encryptOAuthSecret('fb-route-token'),
          connection_id: 'conn_scheduled_attempt',
          external_account_id: 'page_scheduled_attempt',
        }],
        rowCount: 1,
      };
    }
    if (/SELECT DISTINCT platform FROM posts|SELECT platform, max\(published_at\)/i.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    if (/UPDATE posts/i.test(text)) {
      const token = params[4];
      const ownsConditionalUpdate = options.finalizeOwned === false
        ? false
        : options.owned && token === 'attempt-current';
      return {
        rows: ownsConditionalUpdate ? [{ job_id: null }] : [],
        rowCount: ownsConditionalUpdate ? 1 : 0,
      };
    }
    if (/UPDATE insights_posts/i.test(text)) {
      if (options.insightExists && params[3] === providerPostId) {
        ariesPostId = String(params[0]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }) as unknown as typeof pool.query;

  return {
    calls,
    providerPostId,
    getAriesPostId: () => ariesPostId,
    restore: () => {
      (pool as typeof pool & { query: typeof pool.query }).query = originalQuery;
    },
  };
}

async function withDispatchEnv(run: (secret: string) => Promise<void>): Promise<void> {
  const originalSecret = process.env.INTERNAL_API_SECRET;
  const originalEncryptionKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  const secret = 'scheduled-attempt-test-secret';
  process.env.INTERNAL_API_SECRET = secret;
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  try {
    await run(secret);
  } finally {
    if (originalSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = originalSecret;
    if (originalEncryptionKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
  }
}

test('stale scheduled request is rejected before publish and cannot mutate aggregate or Insights state', async () => {
  await withDispatchEnv(async (secret) => {
    const fixture = installDispatchFixture({ owned: false, insightExists: true });
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('stale request must not reach a provider');
    }) as typeof fetch;

    try {
      const response = await POST(makeRequest(secret, 'attempt-stale'));
      const body = (await response.json()) as { status?: string; error?: string };

      assert.equal(response.status, 409);
      assert.equal(body.status, 'stale_attempt');
      assert.equal(fetchCalled, false, 'ownership is checked before the provider publish');
      assert.equal(fixture.calls.some((call) => /UPDATE posts/i.test(call.sql)), false);
      assert.equal(fixture.calls.some((call) => /UPDATE insights_posts/i.test(call.sql)), false);
    } finally {
      globalThis.fetch = originalFetch;
      fixture.restore();
    }
  });
});

test('request that loses ownership during provider I/O cannot mutate aggregate, child winner, or Insights state', async () => {
  await withDispatchEnv(async (secret) => {
    const fixture = installDispatchFixture({
      owned: true,
      finalizeOwned: false,
      insightExists: true,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: fixture.providerPostId, post_id: fixture.providerPostId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      const response = await POST(makeRequest(secret, 'attempt-current'));
      assert.equal(response.status, 202, 'the provider may already have accepted the publish');

      const aggregateUpdate = fixture.calls.find((call) => /UPDATE posts/i.test(call.sql));
      assert.ok(aggregateUpdate, 'post-publish finalization must attempt the ownership-fenced aggregate write');
      assert.match(aggregateUpdate.sql, /owner\.dispatch_attempt_token = \$5/);
      assert.equal(
        fixture.calls.some((call) => /UPDATE insights_posts/i.test(call.sql)),
        false,
        'a request that lost ownership must not stamp Insights attribution',
      );
      assert.equal(
        fixture.calls.some((call) => /UPDATE scheduled_post_dispatches/i.test(call.sql)),
        false,
        'the dispatch route never writes child winner state; only the token-fenced worker does',
      );
    } finally {
      globalThis.fetch = originalFetch;
      fixture.restore();
    }
  });
});

test('owned scheduled dispatch stamps an already-existing matching Insights row from the provider id', async () => {
  await withDispatchEnv(async (secret) => {
    const fixture = installDispatchFixture({ owned: true, insightExists: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: fixture.providerPostId, post_id: fixture.providerPostId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      const response = await POST(makeRequest(secret, 'attempt-current'));
      const body = (await response.json()) as {
        status: string;
        results: Array<{ provider: string; ok: boolean; platformPostId?: string }>;
      };

      assert.equal(response.status, 202);
      assert.equal(body.status, 'ok');
      assert.equal(body.results[0]?.platformPostId, fixture.providerPostId);
      assert.equal(fixture.getAriesPostId(), '901', 'the dispatch route itself must stamp aries_post_id');
      const stamp = fixture.calls.find((call) => /UPDATE insights_posts/i.test(call.sql));
      assert.ok(stamp, 'dispatch-time finalization must execute the additive Insights UPDATE');
      assert.deepEqual(stamp.params, ['901', 15, 'facebook', fixture.providerPostId]);
    } finally {
      globalThis.fetch = originalFetch;
      fixture.restore();
    }
  });
});

test('owned scheduled dispatch succeeds when the Insights row is absent and leaves later sync attribution intact', async () => {
  await withDispatchEnv(async (secret) => {
    const fixture = installDispatchFixture({ owned: true, insightExists: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: fixture.providerPostId, post_id: fixture.providerPostId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      const response = await POST(makeRequest(secret, 'attempt-current'));
      assert.equal(response.status, 202);
      assert.equal(fixture.getAriesPostId(), null);
      assert.ok(fixture.calls.some((call) => /UPDATE insights_posts/i.test(call.sql)));
      assert.equal(
        fixture.calls.some((call) => /INSERT INTO insights_posts/i.test(call.sql)),
        false,
        'dispatch never fabricates an Insights row; the existing sync upsert remains the later attribution path',
      );
    } finally {
      globalThis.fetch = originalFetch;
      fixture.restore();
    }
  });
});
