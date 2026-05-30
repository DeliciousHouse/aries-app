import assert from 'node:assert/strict';
import test from 'node:test';

import pool from '../lib/db';
import {
  classifyMetaPublishFailure,
  classifyMetaPublishFailureKind,
  publishToMetaGraph,
  MetaPublishError,
  waitForInstagramContainerReady,
} from '../backend/integrations/meta-publishing';
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

// ---- publish failure taxonomy: "definitely never posted" vs "outcome unknown" ----
//
// Regression for TODOS "Harden Meta publish failure taxonomy". The Meta publish
// path has two failure classes that need opposite handling:
//
//   "Definitely never posted" — a requestGraphJson network/HTTP/4xx failure on
//   the final publish call. The post never went live. The handler rolls back the
//   platform claim so a retry can re-attempt the platform.
//
//   "Outcome unknown" — *_publish_missing_id: the Graph publish call returned 2xx
//   but with no post id. The post MAY be live. The handler must LEAVE the claim
//   in place, surface needs_manual_reconciliation, and NEVER auto-retry — a retry
//   of a publish that secretly succeeded is a duplicate post.
//
// The handlers branch on MetaPublishError.outcomeUnknown, so these tests pin the
// flag values that drive that branch.

test('publishToMetaGraph: a Facebook feed HTTP 400 is "definitely never posted" (retryable rollback class, not outcomeUnknown)', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_fail',
    external_account_id: 'page_fail',
  });

  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/feed')) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid parameter' } }),
        { status: 400 },
      );
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    await assert.rejects(
      () => publishToMetaGraph({
        tenantId: '12',
        provider: 'facebook',
        content: 'will fail',
        mediaUrls: [],
        fetchImpl: fetchImpl as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        const publishError = error as MetaPublishError;
        // graph_api_error from requestGraphJson — the feed POST was rejected,
        // the post never went live.
        assert.equal(publishError.code, 'graph_api_error');
        assert.equal(
          publishError.outcomeUnknown,
          false,
          'a rejected feed POST is definitely-never-posted, not outcome-unknown',
        );
        return true;
      },
    );
  } finally {
    restoreQuery();
  }
});

test('publishToMetaGraph: a Facebook feed 2xx with no post id is "outcome unknown" (claim must stay, never retry)', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_unknown',
    external_account_id: 'page_unknown',
  });

  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/feed')) {
      // Graph accepted the publish (2xx) but returned no `id`.
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    await assert.rejects(
      () => publishToMetaGraph({
        tenantId: '12',
        provider: 'facebook',
        content: 'accepted but unconfirmed',
        mediaUrls: [],
        fetchImpl: fetchImpl as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        const publishError = error as MetaPublishError;
        assert.equal(publishError.code, 'facebook_publish_missing_id');
        assert.equal(
          publishError.outcomeUnknown,
          true,
          'a 2xx feed POST with no id means the outcome is unconfirmed',
        );
        assert.equal(
          publishError.retryable,
          false,
          'an outcome-unknown publish must never be auto-retried (duplicate-post risk)',
        );
        return true;
      },
    );
  } finally {
    restoreQuery();
  }
});

test('publishToMetaGraph: an Instagram media_publish 2xx with no post id is "outcome unknown"', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-page-token'),
    connection_id: 'conn_ig_unknown',
    external_account_id: 'ig_unknown',
  });

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/media_publish')) {
      // Graph accepted the publish (2xx) but returned no `id`.
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (method === 'GET' && url.includes('container_u1') && url.includes('status_code')) {
      return new Response(JSON.stringify({ id: 'container_u1', status_code: 'FINISHED' }), { status: 200 });
    }
    if (url.includes('/media')) {
      return new Response(JSON.stringify({ id: 'container_u1' }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    await assert.rejects(
      () => publishToMetaGraph({
        tenantId: '12',
        provider: 'instagram',
        content: 'accepted but unconfirmed',
        mediaUrls: ['https://cdn.example.com/ig.png'],
        fetchImpl: fetchImpl as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        const publishError = error as MetaPublishError;
        assert.equal(publishError.code, 'instagram_publish_missing_id');
        assert.equal(
          publishError.outcomeUnknown,
          true,
          'a 2xx media_publish with no id means the outcome is unconfirmed',
        );
        assert.equal(publishError.retryable, false, 'outcome-unknown must never auto-retry');
        return true;
      },
    );
  } finally {
    restoreQuery();
  }
});

test('publishToMetaGraph: an Instagram media_publish HTTP failure is "definitely never posted", not outcomeUnknown', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-page-token'),
    connection_id: 'conn_ig_fail',
    external_account_id: 'ig_fail',
  });

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/media_publish')) {
      return new Response(
        JSON.stringify({ error: { message: 'Media publish rejected' } }),
        { status: 400 },
      );
    }
    if (method === 'GET' && url.includes('container_f1') && url.includes('status_code')) {
      return new Response(JSON.stringify({ id: 'container_f1', status_code: 'FINISHED' }), { status: 200 });
    }
    if (url.includes('/media')) {
      return new Response(JSON.stringify({ id: 'container_f1' }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    await assert.rejects(
      () => publishToMetaGraph({
        tenantId: '12',
        provider: 'instagram',
        content: 'will fail',
        mediaUrls: ['https://cdn.example.com/ig.png'],
        fetchImpl: fetchImpl as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        const publishError = error as MetaPublishError;
        assert.equal(publishError.code, 'graph_api_error');
        assert.equal(
          publishError.outcomeUnknown,
          false,
          'a rejected media_publish is definitely-never-posted, not outcome-unknown',
        );
        return true;
      },
    );
  } finally {
    restoreQuery();
  }
});

test('publishToMetaGraph: a pre-publish media-upload missing id is NOT outcomeUnknown (nothing was published)', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_preupload',
    external_account_id: 'page_preupload',
  });

  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/photos')) {
      // Unpublished photo upload returns 2xx but no id — pre-publish step,
      // no post was created, so this is still "definitely never posted".
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    await assert.rejects(
      () => publishToMetaGraph({
        tenantId: '12',
        provider: 'facebook',
        content: 'with media',
        mediaUrls: ['https://cdn.example.com/image.png'],
        fetchImpl: fetchImpl as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        const publishError = error as MetaPublishError;
        assert.equal(publishError.code, 'facebook_media_upload_missing_id');
        assert.equal(
          publishError.outcomeUnknown,
          false,
          'a pre-publish media upload failure means the feed POST never ran — definitely never posted',
        );
        return true;
      },
    );
  } finally {
    restoreQuery();
  }
});

// ---- classifyMetaPublishFailure: the predicate the publish handlers branch on ----
//
// The handlers compute `outcomeUnknown = classifyMetaPublishFailure(error)`,
// then: roll back the platform claim ONLY when the class is
// 'definitely_never_posted' (and the publish never succeeded); on
// 'outcome_unknown' they leave the claim in place and return
// needs_manual_reconciliation with retryable=false. These tests pin that
// classification end-to-end against the real errors publishToMetaGraph throws.

test('classifyMetaPublishFailure: a definitely-never-posted feed HTTP failure is the retryable rollback class', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_cls1',
    external_account_id: 'page_cls1',
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    if (String(input).includes('/feed')) {
      return new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 });
    }
    throw new Error('unexpected');
  };
  try {
    const caught = await publishToMetaGraph({
      tenantId: '12',
      provider: 'facebook',
      content: 'x',
      mediaUrls: [],
      fetchImpl: fetchImpl as typeof fetch,
    }).then(() => null, (e: unknown) => e);

    assert.ok(caught instanceof MetaPublishError);
    assert.equal(classifyMetaPublishFailure(caught), 'definitely_never_posted');
    // Handler rollback predicate: definitely_never_posted -> roll back the claim.
    const outcomeUnknown = classifyMetaPublishFailure(caught) === 'outcome_unknown';
    assert.equal(outcomeUnknown, false, 'definitely-never-posted must roll back + allow retry');
  } finally {
    restoreQuery();
  }
});

test('classifyMetaPublishFailure: an outcome-unknown missing-id failure is the no-rollback / no-retry class', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_cls2',
    external_account_id: 'page_cls2',
  });
  const fetchImpl = async (input: RequestInfo | URL) => {
    if (String(input).includes('/feed')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    throw new Error('unexpected');
  };
  try {
    const caught = await publishToMetaGraph({
      tenantId: '12',
      provider: 'facebook',
      content: 'x',
      mediaUrls: [],
      fetchImpl: fetchImpl as typeof fetch,
    }).then(() => null, (e: unknown) => e);

    assert.ok(caught instanceof MetaPublishError);
    assert.equal(classifyMetaPublishFailure(caught), 'outcome_unknown');
    // Handler rollback predicate: outcome_unknown -> claim stays, no retry.
    const outcomeUnknown = classifyMetaPublishFailure(caught) === 'outcome_unknown';
    assert.equal(outcomeUnknown, true, 'outcome-unknown must keep the claim and never auto-retry');
    assert.equal((caught as MetaPublishError).retryable, false);
  } finally {
    restoreQuery();
  }
});

test('classifyMetaPublishFailure: a non-MetaPublishError throw defaults to definitely_never_posted', () => {
  assert.equal(classifyMetaPublishFailure(new Error('socket hang up')), 'definitely_never_posted');
  assert.equal(classifyMetaPublishFailure('plain string'), 'definitely_never_posted');
  assert.equal(classifyMetaPublishFailure(undefined), 'definitely_never_posted');
});

test('classifyMetaPublishFailure: a MetaPublishError without outcomeUnknown is definitely_never_posted', () => {
  const networkError = new MetaPublishError('graph_network_error', 'ECONNRESET', {
    status: 502,
    retryable: true,
  });
  assert.equal(classifyMetaPublishFailure(networkError), 'definitely_never_posted');
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

test('publishToMetaGraph publishes a Facebook image story via /photos then /photo_stories', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_story',
    external_account_id: 'page_story',
  });

  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, method, body });
    if (url.includes('/photo_stories')) {
      assert.match(body ?? '', /photo_id=photo_story_001/);
      return new Response(JSON.stringify({ success: true, post_id: 'fb_story_777' }), { status: 200 });
    }
    if (url.includes('/photos')) {
      assert.match(body ?? '', /published=false/);
      return new Response(JSON.stringify({ id: 'photo_story_001' }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    const result = await publishToMetaGraph({
      tenantId: '12',
      provider: 'facebook',
      content: 'caption ignored on stories',
      mediaUrls: ['https://cdn.example.com/story.png'],
      placement: 'story',
      fetchImpl: fetchImpl as typeof fetch,
    });

    assert.equal(result.provider, 'facebook');
    assert.equal(result.mode, 'live');
    assert.equal(result.platformPostId, 'fb_story_777');
    // Exactly two calls: unpublished photo upload, then publish-as-story. NO /feed.
    assert.equal(calls.length, 2);
    assert.match(calls[0]?.url ?? '', /\/page_story\/photos$/);
    assert.match(calls[1]?.url ?? '', /\/page_story\/photo_stories$/);
    assert.ok(!calls.some((c) => c.url.includes('/feed')), 'a story must never hit /feed');
  } finally {
    restoreQuery();
  }
});

test('publishToMetaGraph publishes an Instagram image story via media_type=STORIES container', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-page-token'),
    connection_id: 'conn_ig_story',
    external_account_id: 'ig_story',
  });

  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, method, body });
    if (url.includes('/media_publish')) {
      assert.match(body ?? '', /creation_id=story_container_001/);
      return new Response(JSON.stringify({ id: 'ig_story_888' }), { status: 200 });
    }
    if (method === 'GET' && url.includes('story_container_001') && url.includes('status_code')) {
      return new Response(JSON.stringify({ id: 'story_container_001', status_code: 'FINISHED' }), { status: 200 });
    }
    if (url.includes('/media')) {
      assert.match(body ?? '', /media_type=STORIES/);
      assert.match(body ?? '', /image_url=https%3A%2F%2Fcdn.example.com%2Fig-story.png/);
      // Stories ignore the feed caption; it must not be sent.
      assert.ok(!(body ?? '').includes('caption='), 'story container must not send a caption');
      return new Response(JSON.stringify({ id: 'story_container_001' }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  try {
    const result = await publishToMetaGraph({
      tenantId: '12',
      provider: 'instagram',
      content: 'caption ignored on stories',
      mediaUrls: ['https://cdn.example.com/ig-story.png'],
      placement: 'story',
      fetchImpl: fetchImpl as typeof fetch,
    });

    assert.equal(result.provider, 'instagram');
    assert.equal(result.mode, 'live');
    assert.equal(result.platformPostId, 'ig_story_888');
    assert.equal(calls.length, 3);
  } finally {
    restoreQuery();
  }
});

test('publishToMetaGraph rejects a story with more than one image before any Graph call', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_story_multi',
    external_account_id: 'page_story_multi',
  });

  try {
    await assert.rejects(
      () => publishToMetaGraph({
        tenantId: '12',
        provider: 'facebook',
        content: '',
        mediaUrls: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
        placement: 'story',
        fetchImpl: (async () => {
          throw new Error('fetch must not be called for a rejected story');
        }) as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        assert.equal((error as MetaPublishError).code, 'story_single_media_required');
        assert.equal((error as MetaPublishError).status, 400);
        return true;
      },
    );
  } finally {
    restoreQuery();
  }
});

test('publishToMetaGraph rejects a natively-scheduled story before any Graph call', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restoreQuery = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-page-token'),
    connection_id: 'conn_ig_story_sched',
    external_account_id: 'ig_story_sched',
  });

  try {
    await assert.rejects(
      () => publishToMetaGraph({
        tenantId: '12',
        provider: 'instagram',
        content: '',
        mediaUrls: ['https://cdn.example.com/story.png'],
        placement: 'story',
        scheduledFor: '2026-06-01T15:00:00.000Z',
        fetchImpl: (async () => {
          throw new Error('fetch must not be called for a rejected story');
        }) as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MetaPublishError);
        assert.equal((error as MetaPublishError).code, 'story_scheduled_publish_not_supported');
        assert.equal((error as MetaPublishError).status, 409);
        return true;
      },
    );
  } finally {
    restoreQuery();
  }
});


// ---- classifyMetaPublishFailureKind: the 4-class taxonomy ----
//
// Every known MetaPublishError code must map to exactly one kind from the
// Current State table. The handlers + dispatch route + worker branch on this:
// 'auth' -> needs_reconnect; 'transient' -> retryable; 'permanent' -> terminal;
// 'outcome_unknown' -> never retry (claim left in place). outcome_unknown wins
// over every other axis when outcomeUnknown is set.

type KindCase = {
  code: string;
  status: number;
  retryable?: boolean;
  outcomeUnknown?: boolean;
  expected: 'transient' | 'permanent' | 'auth' | 'outcome_unknown';
};

const KIND_CASES: KindCase[] = [
  { code: 'unsupported_provider', status: 400, expected: 'permanent' },
  { code: 'invalid_scheduled_for', status: 400, expected: 'permanent' },
  { code: 'missing_content', status: 400, expected: 'permanent' },
  { code: 'instagram_media_required', status: 400, expected: 'permanent' },
  { code: 'story_single_media_required', status: 400, expected: 'permanent' },
  { code: 'oauth_token_missing', status: 409, expected: 'auth' },
  { code: 'external_account_missing', status: 409, expected: 'auth' },
  { code: 'facebook_scheduled_publish_not_supported', status: 409, expected: 'permanent' },
  { code: 'story_scheduled_publish_not_supported', status: 409, expected: 'permanent' },
  { code: 'graph_network_error', status: 502, retryable: true, expected: 'transient' },
  { code: 'graph_rate_limited', status: 429, retryable: true, expected: 'transient' },
  { code: 'graph_api_error', status: 503, retryable: true, expected: 'transient' },
  { code: 'graph_api_error', status: 400, retryable: false, expected: 'permanent' },
  { code: 'instagram_container_timeout', status: 504, retryable: true, expected: 'transient' },
  { code: 'instagram_container_failed', status: 422, retryable: false, expected: 'permanent' },
  { code: 'facebook_publish_missing_id', status: 502, outcomeUnknown: true, expected: 'outcome_unknown' },
  { code: 'instagram_publish_missing_id', status: 502, outcomeUnknown: true, expected: 'outcome_unknown' },
];

for (const c of KIND_CASES) {
  test(`classifyMetaPublishFailureKind: ${c.code} (status ${c.status}) -> ${c.expected}`, () => {
    const err = new MetaPublishError(c.code, `${c.code} message`, {
      status: c.status,
      retryable: c.retryable,
      outcomeUnknown: c.outcomeUnknown,
    });
    assert.equal(classifyMetaPublishFailureKind(err), c.expected);
  });
}

test('classifyMetaPublishFailureKind: outcome_unknown wins over transient (retryable + outcomeUnknown)', () => {
  // A pathological error flagged BOTH retryable and outcomeUnknown must classify
  // as outcome_unknown — never transient. Retrying a publish that secretly
  // succeeded is a duplicate post.
  const err = new MetaPublishError('weird_both', 'both flags set', {
    status: 502,
    retryable: true,
    outcomeUnknown: true,
  });
  assert.equal(classifyMetaPublishFailureKind(err), 'outcome_unknown');
});

test('classifyMetaPublishFailureKind: a non-MetaPublishError throw is permanent', () => {
  assert.equal(classifyMetaPublishFailureKind(new Error('boom')), 'permanent');
  assert.equal(classifyMetaPublishFailureKind('a bare string'), 'permanent');
  assert.equal(classifyMetaPublishFailureKind(undefined), 'permanent');
});

test('classifyMetaPublishFailureKind: auth wins over the retryable axis', () => {
  // An auth code flagged retryable (defensive — should never happen) still
  // classifies as auth so the operator sees the reconnect signal.
  const err = new MetaPublishError('oauth_token_missing', 'expired', {
    status: 409,
    retryable: true,
  });
  assert.equal(classifyMetaPublishFailureKind(err), 'auth');
});
