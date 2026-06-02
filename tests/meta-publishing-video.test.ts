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

const VIDEO_META = [{ widthPx: 1080, heightPx: 1920, durationSeconds: 30 }];

test('IG Reel publishes via media_type=REELS video_url -> poll -> media_publish', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restore = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-token'),
    connection_id: 'conn_ig_reel',
    external_account_id: 'ig_acc_1',
  });
  const calls: Array<{ url: string; body: string | null }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, body });
    if (url.includes('/media_publish')) return new Response(JSON.stringify({ id: 'reel_post_1' }), { status: 200 });
    if (url.includes('/media')) {
      assert.match(body ?? '', /media_type=REELS/);
      assert.match(body ?? '', /video_url=/);
      return new Response(JSON.stringify({ id: 'container_reel' }), { status: 200 });
    }
    // poll
    return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
  };
  try {
    const result = await publishToMetaGraph({
      tenantId: '15',
      provider: 'instagram',
      content: 'reel caption',
      mediaUrls: ['https://cdn.example.com/reel.mp4'],
      placement: 'reel',
      mediaType: 'video',
      mediaMetadata: VIDEO_META,
      fetchImpl: fetchImpl as typeof fetch,
    });
    assert.equal(result.platformPostId, 'reel_post_1');
    assert.ok(calls.some((c) => /media_type=REELS/.test(c.body ?? '')));
  } finally {
    restore();
  }
});

test('IG video Story: 2xx media_publish with no id is outcomeUnknown (not retried)', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restore = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('ig-token'),
    connection_id: 'conn_ig_story',
    external_account_id: 'ig_acc_2',
  });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    if (url.includes('/media_publish')) return new Response(JSON.stringify({}), { status: 200 });
    if (url.includes('/media')) {
      assert.match(body ?? '', /media_type=STORIES/);
      assert.match(body ?? '', /video_url=/);
      return new Response(JSON.stringify({ id: 'container_story' }), { status: 200 });
    }
    return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
  };
  try {
    await publishToMetaGraph({
      tenantId: '15',
      provider: 'instagram',
      content: '',
      mediaUrls: ['https://cdn.example.com/s.mp4'],
      placement: 'story',
      mediaType: 'video',
      mediaMetadata: VIDEO_META,
      fetchImpl: fetchImpl as typeof fetch,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof MetaPublishError);
    assert.equal(err.outcomeUnknown, true);
  } finally {
    restore();
  }
});

test('FB video feed publishes via /videos file_url', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restore = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_vid',
    external_account_id: 'page_1',
  });
  const calls: Array<{ url: string; body: string | null }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, body });
    if (url.includes('/videos')) {
      assert.match(body ?? '', /file_url=/);
      return new Response(JSON.stringify({ id: 'fb_video_1' }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const result = await publishToMetaGraph({
      tenantId: '15',
      provider: 'facebook',
      content: 'fb video',
      mediaUrls: ['https://cdn.example.com/fb.mp4'],
      placement: 'feed',
      mediaType: 'video',
      mediaMetadata: [{ widthPx: 1920, heightPx: 1080, durationSeconds: 30 }],
      fetchImpl: fetchImpl as typeof fetch,
    });
    assert.equal(result.platformPostId, 'fb_video_1');
    assert.match(calls[0]?.url ?? '', /\/page_1\/videos$/);
  } finally {
    restore();
  }
});

test('FB video Story: start -> finish via /video_stories', async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  const restore = installOauthQueryFixture({
    access_token_enc: encryptOAuthSecret('page-token'),
    connection_id: 'conn_fb_vstory',
    external_account_id: 'page_2',
  });
  const phases: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    if (url.includes('/video_stories')) {
      if (/upload_phase=start/.test(body ?? '')) {
        phases.push('start');
        return new Response(JSON.stringify({ video_id: 'vid_99' }), { status: 200 });
      }
      if (/upload_phase=finish/.test(body ?? '')) {
        phases.push('finish');
        assert.match(body ?? '', /video_id=vid_99/);
        return new Response(JSON.stringify({ post_id: 'fb_story_1' }), { status: 200 });
      }
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const result = await publishToMetaGraph({
      tenantId: '15',
      provider: 'facebook',
      content: '',
      mediaUrls: ['https://cdn.example.com/fbs.mp4'],
      placement: 'story',
      mediaType: 'video',
      mediaMetadata: VIDEO_META,
      fetchImpl: fetchImpl as typeof fetch,
    });
    assert.equal(result.platformPostId, 'fb_story_1');
    assert.deepEqual(phases, ['start', 'finish']);
  } finally {
    restore();
  }
});
