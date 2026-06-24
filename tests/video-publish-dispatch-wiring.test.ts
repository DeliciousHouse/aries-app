/**
 * Regression tests for the video-publish-foundation wiring:
 *   Slice 1 — schema DDL (init-db.js + migration)
 *   Slice 2 — mediaMetadata threading through dispatchPublish and the
 *             scheduled-dispatch route handler
 *
 * FAILING BEFORE the change: the route and dispatchPublish had no
 * width_px/height_px/duration_seconds columns in scheduled_posts, no
 * mediaMetadata field in PublishPostInput, and the Composio leg of
 * dispatchPublish omitted mediaMetadata entirely. The validator
 * (meta-media-validation.ts) requires all three for any video surface and
 * fails closed — so every video publish ended with missing_video_metadata
 * before reaching the Graph API.
 *
 * PASSING AFTER: dims flow from the POST body → mediaMetadata → dispatchPublish
 * → publishToMetaGraph → validator passes → Graph REELS call goes out.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { dispatchPublish } from '../backend/integrations/publish-dispatch';
import type {
  MetaPublishRequest,
  MetaPublishSuccess,
} from '../backend/integrations/meta-publishing';
import type { PublisherProvider } from '../backend/integrations/providers/interfaces';
import type { PublishPostInput, PublishResult } from '../backend/integrations/providers/types';
import pool from '../lib/db';
import { encryptOAuthSecret } from '../backend/integrations/oauth-token-crypto';
import { POST } from '../app/api/internal/publishing/scheduled-dispatch/route';

const repoRoot = process.cwd();

// ── Section 1: dispatchPublish mediaMetadata threading (pure unit, no DB) ────
//
// These prove Slice 2 at the dispatch boundary. No DB or network needed — DI
// injection stubs out the provider.

const VIDEO_META = [{ widthPx: 1080, heightPx: 1920, durationSeconds: 30 }] as const;

test('dispatchPublish: mediaMetadata with valid dims is forwarded intact to the direct provider', async () => {
  const directCalls: MetaPublishRequest[] = [];
  const directResult: MetaPublishSuccess = {
    provider: 'instagram',
    mode: 'live',
    platformPostId: 'ig_reel_dispatch_1',
    scheduledFor: null,
    connectionId: 'conn_1',
  };

  await dispatchPublish(
    {
      tenantId: '15',
      provider: 'instagram',
      content: 'reel caption',
      mediaUrls: ['https://cdn.example.com/reel.mp4'],
      placement: 'reel',
      mediaType: 'video',
      mediaMetadata: [...VIDEO_META],
    },
    {
      selector: () => 'direct_meta',
      directPublish: async (r) => {
        directCalls.push(r);
        return directResult;
      },
    },
  );

  assert.equal(directCalls.length, 1, 'directPublish must be called exactly once');
  assert.deepEqual(
    directCalls[0]!.mediaMetadata,
    VIDEO_META,
    'mediaMetadata must reach directPublish intact — no mutation or stripping',
  );
});

test('dispatchPublish: absent mediaMetadata is forwarded as undefined (no fabricated zeros)', async () => {
  const directCalls: MetaPublishRequest[] = [];
  const directResult: MetaPublishSuccess = {
    provider: 'instagram',
    mode: 'live',
    platformPostId: 'ig_feed_dispatch_1',
    scheduledFor: null,
    connectionId: 'conn_2',
  };

  await dispatchPublish(
    {
      tenantId: '15',
      provider: 'instagram',
      content: 'image post',
      mediaUrls: ['https://cdn.example.com/img.png'],
      // no mediaMetadata — must stay absent, never be replaced with zeros
    },
    {
      selector: () => 'direct_meta',
      directPublish: async (r) => {
        directCalls.push(r);
        return directResult;
      },
    },
  );

  assert.equal(directCalls.length, 1);
  assert.equal(
    directCalls[0]!.mediaMetadata,
    undefined,
    'absent mediaMetadata must arrive at directPublish as undefined, not [{ widthPx: 0, ... }]',
  );
});

test('dispatchPublish: mediaMetadata is forwarded to Composio provider publishPost', async () => {
  const composioCalls: PublishPostInput[] = [];
  const composioProvider: PublisherProvider = {
    kind: 'composio',
    supports: () => true,
    publishPost: async (input: PublishPostInput): Promise<PublishResult> => {
      composioCalls.push(input);
      return {
        provider: 'composio',
        platform: 'instagram',
        externalPostId: 'ig_composio_reel_1',
        externalCampaignId: null,
        externalAdId: null,
        status: 'published',
        url: null,
        rawResponse: {},
      };
    },
  } as unknown as PublisherProvider;

  await dispatchPublish(
    {
      tenantId: '15',
      provider: 'instagram',
      content: 'composio reel',
      mediaUrls: ['https://cdn.example.com/reel.mp4'],
      placement: 'reel',
      mediaType: 'video',
      mediaMetadata: [...VIDEO_META],
    },
    {
      selector: () => 'composio',
      publisherProvider: () => composioProvider,
    },
  );

  assert.equal(composioCalls.length, 1, 'Composio publishPost must be called');
  assert.deepEqual(
    composioCalls[0]!.mediaMetadata,
    VIDEO_META,
    'mediaMetadata must reach Composio publishPost — not stripped on the Composio leg',
  );
});

// ── Section 2: Route handler POST — mediaMetadata derivation + end-to-end ────
//
// These prove Slice 2 from the HTTP boundary. The route receives dims in the
// POST body, builds mediaMetadata, and passes it into dispatchPublish which
// feeds publishToMetaGraph. The validator must pass (dims present) or reject
// (dims absent) at exactly the right point.

/**
 * Pool fixture: returns an oauth token row for instagram queries; returns
 * empty rows for every other query (status UPDATEs, recompute helpers, etc.).
 * The pool.query overload is broad-cast with `as unknown` like existing tests.
 */
function installPoolFixture(accessTokenEnc: string, externalAccountId: string) {
  const originalQuery = pool.query.bind(pool);
  (pool as typeof pool & { query: typeof pool.query }).query = (async (
    sql: unknown,
    _params?: unknown,
  ) => {
    const upperSql = typeof sql === 'string' ? sql.toUpperCase() : '';
    if (upperSql.includes('OAUTH_TOKENS') || upperSql.includes('OAUTH_CONNECTIONS')) {
      return {
        rows: [
          {
            access_token_enc: accessTokenEnc,
            connection_id: 'conn_route_test',
            external_account_id: externalAccountId,
          },
        ],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };
    }
    return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
  }) as unknown as typeof pool.query;
  return () => {
    (pool as typeof pool & { query: typeof pool.query }).query = originalQuery;
  };
}

function makeScheduledDispatchRequest(
  body: Record<string, unknown>,
  secret: string,
): Request {
  return new Request(
    'https://aries.example.com/api/internal/publishing/scheduled-dispatch',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
    },
  );
}

/**
 * Route POST: video body with width_px + height_px + duration_seconds present
 * → mediaMetadata = [{ widthPx, heightPx, durationSeconds }]
 * → validator passes (9:16 reel, 30s inside 3–90s window)
 * → IG container creation goes out with media_type=REELS
 * → response is 202 ok
 */
test('route POST: video + dims present → mediaMetadata built → REELS Graph call → 202', async () => {
  const secret = 'test-secret-for-video-dispatch-wiring';
  const prevSecret = process.env.INTERNAL_API_SECRET;
  const prevEncKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  process.env.INTERNAL_API_SECRET = secret;
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';

  const accessTokenEnc = encryptOAuthSecret('ig-route-token');
  const restorePool = installPoolFixture(accessTokenEnc, 'ig_acc_route_wiring');

  const graphCalls: Array<{ url: string; body: string | null }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    graphCalls.push({ url, body });
    // IG media_publish (final step)
    if (url.includes('/media_publish')) {
      return new Response(JSON.stringify({ id: 'route_reel_post_1' }), { status: 200 });
    }
    // IG container creation (first step: creates REELS container)
    if (url.includes('/media')) {
      return new Response(JSON.stringify({ id: 'route_container_1' }), { status: 200 });
    }
    // Container status poll: return FINISHED immediately so no sleep is needed
    return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
  }) as typeof fetch;

  try {
    const req = makeScheduledDispatchRequest(
      {
        tenant_id: '15',
        platforms: ['instagram'],
        content: 'reel video test',
        media_urls: ['https://cdn.example.com/reel.mp4'],
        surface: 'reel',
        media_type: 'video',
        width_px: 1080,
        height_px: 1920,
        duration_seconds: 30,
        // post_id absent → skips DB status UPDATE + recomputePendingApprovalCount
      },
      secret,
    );

    const resp = await POST(req);
    const data = (await resp.json()) as {
      status: string;
      results: Array<{ provider: string; ok: boolean; error?: string }>;
    };

    assert.equal(
      resp.status,
      202,
      `Expected 202 ok; got ${resp.status}: ${JSON.stringify(data)}`,
    );
    assert.equal(data.status, 'ok', 'response body status must be ok');
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0]!.ok, true, 'instagram platform must succeed');

    // The IG container creation Graph call MUST include media_type=REELS.
    // This confirms: (a) mediaMetadata was built from the body dims,
    // (b) it was passed to publishToMetaGraph,
    // (c) the validator accepted it (valid 9:16, 30s reel),
    // (d) createInstagramContainer selected the REELS branch.
    const containerCall = graphCalls.find(
      (c) => c.url.includes('/media') && !c.url.includes('/media_publish'),
    );
    assert.ok(containerCall, 'IG container creation Graph call must have been made');
    assert.match(
      containerCall!.body ?? '',
      /media_type=REELS/,
      'REELS branch requires valid mediaMetadata — proves the end-to-end wiring works',
    );
  } finally {
    globalThis.fetch = origFetch;
    restorePool();
    if (prevSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = prevSecret;
    if (prevEncKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = prevEncKey;
  }
});

/**
 * Route POST: video body WITHOUT width_px / height_px / duration_seconds
 * → mediaMetadata is undefined (route must not fabricate zeros)
 * → publishToMetaGraph builds null dims → validator throws missing_video_metadata
 * → response is 422 (terminal, non-retryable)
 * → NO Graph API calls are made (validator fires before createInstagramContainer)
 *
 * This is the fail-closed invariant: absent dims are rejected, never silently
 * passed to Meta as zeros which would violate the duration/aspect constraints.
 */
test('route POST: video + dims absent → mediaMetadata undefined → missing_video_metadata → 422', async () => {
  const secret = 'test-secret-for-video-dispatch-absent-dims';
  const prevSecret = process.env.INTERNAL_API_SECRET;
  const prevEncKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  process.env.INTERNAL_API_SECRET = secret;
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';

  const accessTokenEnc = encryptOAuthSecret('ig-route-token-absent');
  const restorePool = installPoolFixture(accessTokenEnc, 'ig_acc_route_absent');

  const graphCalls: string[] = [];
  const origFetch = globalThis.fetch;
  // Install a fetch that records calls. Should never be called — the validator
  // must throw before createInstagramContainer is reached. If fetch IS called,
  // it returns an error body so the route returns 502/422 instead of 202;
  // the `graphCalls.length === 0` assertion then catches the bug.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    graphCalls.push(String(input));
    return new Response(
      JSON.stringify({ error: { message: 'unexpected fetch: validator should have rejected first' } }),
      { status: 500 },
    );
  }) as typeof fetch;

  try {
    const req = makeScheduledDispatchRequest(
      {
        tenant_id: '15',
        platforms: ['instagram'],
        content: 'reel without dims',
        media_urls: ['https://cdn.example.com/reel.mp4'],
        surface: 'reel',
        media_type: 'video',
        // width_px / height_px / duration_seconds intentionally absent
        // The route must NOT fabricate { widthPx: 0, ... }
      },
      secret,
    );

    const resp = await POST(req);
    const data = (await resp.json()) as {
      status: string;
      results: Array<{ provider: string; ok: boolean; error?: string }>;
    };

    // All platforms failed terminally (missing_video_metadata is retryable:false)
    assert.equal(
      resp.status,
      422,
      `Expected 422 terminal error; got ${resp.status}: ${JSON.stringify(data)}`,
    );
    assert.equal(data.status, 'error');
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0]!.ok, false, 'instagram must fail');

    // The error must specifically be missing_video_metadata, not some other
    // error like oauth_token_missing or unsupported_provider. This verifies
    // the code reached the validator (token was found, platform is supported)
    // and the validator correctly identified the missing dims.
    assert.match(
      data.results[0]!.error ?? '',
      /missing_video_metadata/,
      'validator must surface missing_video_metadata when dims are absent',
    );

    // No Graph API calls must have been made — validation fires before the
    // createInstagramContainer call that would trigger the first fetch.
    assert.equal(
      graphCalls.length,
      0,
      'No Graph call must be made when dims are absent — validation is fail-closed',
    );
  } finally {
    globalThis.fetch = origFetch;
    restorePool();
    if (prevSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = prevSecret;
    if (prevEncKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = prevEncKey;
  }
});

// ── Section 3: DDL assertions (Slice 1) ─────────────────────────────────────
//
// Verify that init-db.js and the migration contain the new columns.
// Pattern matches must be loose enough to survive whitespace but specific
// enough to catch a missing column (e.g. it was added only as an ALTER
// but not in the CREATE TABLE).

test('init-db.js: creative_assets CREATE TABLE includes width_px, height_px, duration_seconds', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/init-db.js'), 'utf-8');

  // The CREATE TABLE block for creative_assets must declare all three columns.
  // Use a regex that spans multiple lines ([\s\S]*?) and confirms the column
  // appears inside the same CREATE TABLE block (not in a later ALTER).
  const createBlock = src.match(
    /CREATE TABLE IF NOT EXISTS creative_assets\s*\(([\s\S]*?)\);/,
  );
  assert.ok(createBlock, 'creative_assets CREATE TABLE block must exist');
  const block = createBlock![1];
  assert.match(block, /width_px\s+INTEGER/, 'creative_assets CREATE TABLE must have width_px INTEGER');
  assert.match(block, /height_px\s+INTEGER/, 'creative_assets CREATE TABLE must have height_px INTEGER');
  assert.match(block, /duration_seconds\s+INTEGER/, 'creative_assets CREATE TABLE must have duration_seconds INTEGER');
});

test('init-db.js: ALTER backfills add video columns to posts and scheduled_posts', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/init-db.js'), 'utf-8');

  // posts backfill
  assert.match(
    src,
    /ALTER TABLE posts ADD COLUMN IF NOT EXISTS width_px\s+INTEGER/,
    'posts ALTER backfill must add width_px',
  );
  assert.match(
    src,
    /ALTER TABLE posts ADD COLUMN IF NOT EXISTS height_px\s+INTEGER/,
    'posts ALTER backfill must add height_px',
  );
  assert.match(
    src,
    /ALTER TABLE posts ADD COLUMN IF NOT EXISTS duration_seconds\s+INTEGER/,
    'posts ALTER backfill must add duration_seconds',
  );

  // scheduled_posts backfill
  assert.match(
    src,
    /ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS width_px\s+INTEGER/,
    'scheduled_posts ALTER backfill must add width_px',
  );
  assert.match(
    src,
    /ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS height_px\s+INTEGER/,
    'scheduled_posts ALTER backfill must add height_px',
  );
  assert.match(
    src,
    /ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS duration_seconds\s+INTEGER/,
    'scheduled_posts ALTER backfill must add duration_seconds',
  );
});

test('migration 20260623120000_video_media_metadata.sql is idempotent and covers all three tables', () => {
  const src = fs.readFileSync(
    path.join(repoRoot, 'migrations/20260623120000_video_media_metadata.sql'),
    'utf-8',
  );

  // All three tables must have all three columns added idempotently.
  for (const table of ['creative_assets', 'posts', 'scheduled_posts']) {
    for (const col of ['width_px', 'height_px', 'duration_seconds']) {
      const pattern = new RegExp(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col}`,
        'i',
      );
      assert.match(
        src,
        pattern,
        `migration must contain ADD COLUMN IF NOT EXISTS ${col} for ${table}`,
      );
    }
  }
});
