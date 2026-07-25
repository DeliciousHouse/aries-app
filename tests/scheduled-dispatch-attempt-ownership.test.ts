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
  let ownerLockReads = 0;
  let dispatchStartedAt: string | null = null;
  const originalQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool);
  const providerPostId = options.providerPostId ?? 'fb_canonical_901';

  const query = (async (
    sql: unknown,
    params: unknown[] = [],
  ) => {
    const text = String(sql);
    calls.push({ sql: text, params });

    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    if (/FROM scheduled_posts[\s\S]*FOR UPDATE/i.test(text)) {
      ownerLockReads += 1;
      const attemptToken = !options.owned
        ? 'attempt-new-owner'
        : options.finalizeOwned === false && ownerLockReads > 1
          ? 'attempt-new-owner'
          : 'attempt-current';
      return {
        rows: [{
          dispatch_status: 'in_flight',
          dispatch_attempt_token: attemptToken,
          dispatch_started_at: dispatchStartedAt,
        }],
        rowCount: 1,
      };
    }
    if (/UPDATE scheduled_posts[\s\S]*dispatch_started_at/i.test(text)) {
      dispatchStartedAt = new Date().toISOString();
      return { rows: [{ dispatch_started_at: dispatchStartedAt }], rowCount: 1 };
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
      return {
        rows: [{ job_id: null }],
        rowCount: 1,
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

  (pool as typeof pool & { query: typeof pool.query }).query = query;
  (pool as typeof pool & { connect: typeof pool.connect }).connect = (async () => ({
    query,
    release() {},
  })) as unknown as typeof pool.connect;

  return {
    calls,
    providerPostId,
    getAriesPostId: () => ariesPostId,
    restore: () => {
      (pool as typeof pool & { query: typeof pool.query }).query = originalQuery;
      (pool as typeof pool & { connect: typeof pool.connect }).connect = originalConnect;
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
      assert.equal(aggregateUpdate, undefined, 'post-publish finalization must recheck ownership before aggregate writes');
      assert.ok(
        fixture.calls.some((call) => /FROM scheduled_posts[\s\S]*FOR UPDATE/i.test(call.sql)),
        'post-publish finalization serializes on the scheduled owner row',
      );
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

test('concurrent requests for one attempt token cross provider I/O exactly once', async () => {
  await withDispatchEnv(async (secret) => {
    const fixture = installDispatchFixture({ owned: true, insightExists: false });
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      signalProviderStarted();
      await providerRelease;
      return new Response(JSON.stringify({ id: fixture.providerPostId, post_id: fixture.providerPostId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const first = POST(makeRequest(secret, 'attempt-current'));
      await providerStarted;
      const duplicate = await POST(makeRequest(secret, 'attempt-current'));
      const duplicateBody = (await duplicate.json()) as { status?: string };

      assert.equal(duplicate.status, 409);
      assert.equal(duplicateBody.status, 'attempt_already_started');
      assert.equal(fetchCalls, 1, 'the duplicate request is fenced before provider I/O');

      releaseProvider();
      assert.equal((await first).status, 202);
    } finally {
      globalThis.fetch = originalFetch;
      fixture.restore();
    }
  });
});
