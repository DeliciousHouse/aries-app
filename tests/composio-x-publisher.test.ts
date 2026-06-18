/**
 * Regression coverage for #631: X (Twitter) publish dispatched through Composio
 * gated behind ARIES_X_ENABLED.
 *
 * Failure modes locked:
 *  1. Image post: uploadFile → TWITTER_UPLOAD_MEDIA → TWITTER_CREATION_OF_A_POST,
 *     correct slugs, descriptor, media_media_ids; result published.
 *  2. Text-only post: no uploadFile / upload call; only create call with {text}.
 *  3. Dry-run: no gateway calls.
 *  4. Not-approved: PublishGuardError.
 *  5. Capability missing: publish_post unset → ComposioCapabilityMissingError.
 *     upload_media unset + image → ComposioCapabilityMissingError.
 *  6. Upload failure → ComposioToolError (definitely-never-posted: safe rollback).
 *     Upload-executeTool successful:false → same.
 *     Create-call throw (after upload) is NOT definitely-never-posted (outcome-unknown).
 *  7a. normalizeTargetPlatforms: flag OFF → ['x'] returns null; flag ON → ['x'] valid.
 *  7b. Dispatch guard predicates: isMetaProvider('x') is false; combined guard
 *      rejects x as unsupported when flag off, passes when on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioPublisherProvider } from '@/backend/integrations/composio/composio-publisher-provider';
import { PublishGuardError } from '@/backend/integrations/providers/errors';
import {
  ComposioCapabilityMissingError,
  ComposioConnectionMissingError,
  ComposioToolError,
} from '@/backend/integrations/composio/errors';
import { publishNeverReachedPlatform } from '@/backend/integrations/publish-outcome';
import { isMetaProvider } from '@/backend/integrations/meta-publishing';
import { isXEnabled } from '@/backend/integrations/providers/integration-config';
import { normalizeTargetPlatforms } from '@/backend/social-content/scheduled-posts';
import type { ComposioGateway, ComposioFileDescriptor, ComposioFileUploadInput, GatewayToolResult } from '@/backend/integrations/composio/composio-client';
import type { RecordedExecute } from './composio/helpers';
import { fakeConfig, fakeDb } from './composio/helpers';
import { TOOLKIT_SLUG } from '@/backend/integrations/composio/composio-config';
import type { ComposioOperation } from '@/backend/integrations/composio/composio-config';
import type { IntegrationPlatform } from '@/backend/integrations/providers/types';

const tenantId = '42';

/**
 * A fakeConfig that uses the real TOOLKIT_SLUG mapping so toolkit slug assertions
 * match production behaviour (e.g. 'x' → 'twitter'). The base fakeConfig returns
 * the platform key as-is, which does not match the Composio naming convention.
 */
function xFakeConfig(actions: Partial<Record<ComposioOperation, string>> = {}) {
  const base = fakeConfig({ actions });
  return {
    ...base,
    toolkitSlugFor: (p: IntegrationPlatform) => TOOLKIT_SLUG[p] ?? p,
  };
}

// ── withEnv helper (copied from composio-x-connect.test.ts) ─────────────────

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, original] of prev) {
      if (original === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = original;
      }
    }
  });
}

// ── Custom gateway that tracks uploadFile + executeTool separately ────────────

interface SequencedResult {
  slug: string;
  result: GatewayToolResult;
}

/**
 * Build a gateway that returns per-slug results for executeTool and tracks
 * uploadFile calls independently. `slugResults` maps action slug → result;
 * falls back to `defaultResult` for unrecognised slugs.
 */
function makeXGateway(opts?: {
  slugResults?: Map<string, GatewayToolResult>;
  defaultResult?: GatewayToolResult;
  uploadFileShouldThrow?: Error;
}): ComposioGateway & {
  calls: RecordedExecute[];
  uploadFileCalls: Array<{ file: string; toolSlug: string; toolkitSlug: string }>;
} {
  const calls: RecordedExecute[] = [];
  const uploadFileCalls: Array<{ file: string; toolSlug: string; toolkitSlug: string }> = [];
  const defaultResult: GatewayToolResult =
    opts?.defaultResult ?? { data: {}, successful: true, error: null };

  return {
    calls,
    uploadFileCalls,
    async findOrCreateManagedAuthConfig(toolkitSlug) {
      return `ac_${toolkitSlug}`;
    },
    async initiateConnection() {
      return { connectionRequestId: 'cr_1', redirectUrl: null };
    },
    async listConnections() {
      return [];
    },
    async getConnection() {
      return null;
    },
    async deleteConnection() {
      /* no-op */
    },
    async executeTool(slug, options) {
      const rec = { slug, options };
      calls.push(rec);
      return opts?.slugResults?.get(slug) ?? defaultResult;
    },
    async uploadFile(input: ComposioFileUploadInput): Promise<ComposioFileDescriptor> {
      uploadFileCalls.push(input);
      if (opts?.uploadFileShouldThrow) throw opts.uploadFileShouldThrow;
      return { name: 'staged.jpg', mimetype: 'image/jpeg', s3key: `s3/${input.toolSlug}/staged.jpg` };
    },
  };
}

// ── Actions config for X ──────────────────────────────────────────────────────

const X_ACTIONS = {
  upload_media: 'TWITTER_UPLOAD_MEDIA',
  publish_post: 'TWITTER_CREATION_OF_A_POST',
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// 1. X image post (flag ON)
// ═══════════════════════════════════════════════════════════════════════════════

test('#631 X image post: uploadFile → TWITTER_UPLOAD_MEDIA (with descriptor + tweet_image) → TWITTER_CREATION_OF_A_POST (text + media_media_ids)', async () => {
  const uploadToolResult: GatewayToolResult = {
    data: { media_id_string: 'mid_789' },
    successful: true,
    error: null,
  };
  const createPostResult: GatewayToolResult = {
    data: { id: 'tweet_001', url: 'https://twitter.com/status/tweet_001' },
    successful: true,
    error: null,
  };

  const gateway = makeXGateway({
    slugResults: new Map([
      ['TWITTER_UPLOAD_MEDIA', uploadToolResult],
      ['TWITTER_CREATION_OF_A_POST', createPostResult],
    ]),
  });

  const provider = new ComposioPublisherProvider(
    gateway,
    xFakeConfig(X_ACTIONS),
    fakeDb(),
  );

  const result = await provider.publishPost({
    tenantId,
    platform: 'x',
    content: 'hi',
    mediaUrls: ['https://img.example.com/photo.png'],
    approved: true,
  });

  // Step A: uploadFile must have been called with the correct inputs
  assert.equal(gateway.uploadFileCalls.length, 1, 'uploadFile must be called once');
  assert.equal(
    gateway.uploadFileCalls[0].file,
    'https://img.example.com/photo.png',
    'uploadFile must receive the first mediaUrl as the file',
  );
  assert.equal(
    gateway.uploadFileCalls[0].toolSlug,
    'TWITTER_UPLOAD_MEDIA',
    'uploadFile toolSlug must be the upload_media action slug',
  );
  assert.equal(
    gateway.uploadFileCalls[0].toolkitSlug,
    'twitter',
    'uploadFile toolkitSlug must be the Composio Twitter toolkit slug',
  );

  // Step B: exactly 2 executeTool calls: upload then create
  assert.equal(gateway.calls.length, 2, 'exactly 2 executeTool calls: upload then create');

  // First call: TWITTER_UPLOAD_MEDIA
  const uploadCall = gateway.calls[0];
  assert.equal(uploadCall.slug, 'TWITTER_UPLOAD_MEDIA', 'first executeTool must be the upload slug');
  const uploadArgs = uploadCall.options.arguments as Record<string, unknown>;
  // The media arg must be the staged file descriptor returned by uploadFile
  assert.ok(
    uploadArgs.media && typeof uploadArgs.media === 'object',
    'media arg must be the staged file descriptor',
  );
  const descriptor = uploadArgs.media as ComposioFileDescriptor;
  assert.equal(descriptor.name, 'staged.jpg', 'descriptor name must match fakeGateway stub');
  assert.equal(descriptor.s3key, 's3/TWITTER_UPLOAD_MEDIA/staged.jpg', 'descriptor s3key must match fakeGateway stub');
  assert.equal(uploadArgs.media_category, 'tweet_image', 'media_category must be tweet_image');

  // Second call: TWITTER_CREATION_OF_A_POST
  const createCall = gateway.calls[1];
  assert.equal(
    createCall.slug,
    'TWITTER_CREATION_OF_A_POST',
    'second executeTool must be the create-post slug',
  );
  const createArgs = createCall.options.arguments as Record<string, unknown>;
  assert.equal(createArgs.text, 'hi', 'text must carry the post content');
  const mediaIds = createArgs.media_media_ids as string[];
  assert.ok(Array.isArray(mediaIds), 'media_media_ids must be an array');
  assert.equal(mediaIds.length, 1, 'exactly one media id');
  // The media id is extracted from the upload result by pickId(['media_id_string', ...])
  assert.equal(mediaIds[0], 'mid_789', 'media_media_ids[0] must be the id from the upload result');

  // Result
  assert.equal(result.status, 'published');
  assert.equal(result.externalPostId, 'tweet_001', 'externalPostId must come from the create-post result');
  assert.equal(result.platform, 'x');
  assert.equal(result.provider, 'composio');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. X text-only post: no upload, only create
// ═══════════════════════════════════════════════════════════════════════════════

test('#631 X text-only post: no uploadFile call, no upload executeTool; only create-post with {text}', async () => {
  const createPostResult: GatewayToolResult = {
    data: { id: 'tweet_text_42' },
    successful: true,
    error: null,
  };

  const gateway = makeXGateway({
    slugResults: new Map([['TWITTER_CREATION_OF_A_POST', createPostResult]]),
  });

  const provider = new ComposioPublisherProvider(
    gateway,
    xFakeConfig(X_ACTIONS),
    fakeDb(),
  );

  const result = await provider.publishPost({
    tenantId,
    platform: 'x',
    content: 'just text, no image',
    mediaUrls: [],
    approved: true,
  });

  // No upload steps
  assert.equal(gateway.uploadFileCalls.length, 0, 'uploadFile must NOT be called for text-only');
  assert.equal(gateway.calls.length, 1, 'exactly 1 executeTool call for text-only');

  // The sole call is the create-post
  const createCall = gateway.calls[0];
  assert.equal(createCall.slug, 'TWITTER_CREATION_OF_A_POST');
  const createArgs = createCall.options.arguments as Record<string, unknown>;
  assert.equal(createArgs.text, 'just text, no image');
  assert.equal(
    createArgs.media_media_ids,
    undefined,
    'media_media_ids must NOT be present for text-only posts',
  );

  // X does not use caption/message/page_id — must NOT be present
  assert.equal(createArgs.caption,  undefined, 'caption must not be set for X');
  assert.equal(createArgs.message,  undefined, 'message must not be set for X');
  assert.equal(createArgs.page_id,  undefined, 'page_id must not be set for X');

  assert.equal(result.status, 'published');
  assert.equal(result.externalPostId, 'tweet_text_42');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Dry-run / not-approved guards (mirror FB/IG behavior)
// ═══════════════════════════════════════════════════════════════════════════════

test('#631 X dry-run returns preview without calling the gateway', async () => {
  const gateway = makeXGateway();
  const provider = new ComposioPublisherProvider(
    gateway,
    xFakeConfig(X_ACTIONS),
    fakeDb(),
  );

  const result = await provider.publishPost({
    tenantId,
    platform: 'x',
    content: 'hi',
    mediaUrls: ['https://img.example.com/photo.png'],
    dryRun: true,
  });

  assert.equal(result.status, 'preview', 'dry-run must return preview status');
  assert.equal(gateway.uploadFileCalls.length, 0, 'dry-run must not call uploadFile');
  assert.equal(gateway.calls.length, 0, 'dry-run must not call executeTool');
});

test('#631 X not-approved throws PublishGuardError', async () => {
  const provider = new ComposioPublisherProvider(
    makeXGateway(),
    xFakeConfig(X_ACTIONS),
    fakeDb(),
  );

  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'x',
        content: 'hi',
        mediaUrls: [],
        approved: false,
      }),
    PublishGuardError,
    'unapproved X post must throw PublishGuardError',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Capability missing
// ═══════════════════════════════════════════════════════════════════════════════

test('#631 X publish_post slug unset → ComposioCapabilityMissingError (never guess a slug)', async () => {
  const provider = new ComposioPublisherProvider(
    makeXGateway(),
    xFakeConfig({ upload_media: 'TWITTER_UPLOAD_MEDIA' /* no publish_post */ }),
    fakeDb(),
  );

  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'x',
        content: 'hi',
        mediaUrls: [],
        approved: true,
      }),
    ComposioCapabilityMissingError,
    'missing publish_post slug must throw capability-missing',
  );
});

test('#631 X upload_media slug unset with image → ComposioCapabilityMissingError', async () => {
  const provider = new ComposioPublisherProvider(
    makeXGateway(),
    xFakeConfig({ publish_post: 'TWITTER_CREATION_OF_A_POST' /* no upload_media */ }),
    fakeDb(),
  );

  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'x',
        content: 'hi',
        mediaUrls: ['https://img.example.com/photo.png'],
        approved: true,
      }),
    ComposioCapabilityMissingError,
    'missing upload_media slug with image must throw capability-missing',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Upload failure is definitely-never-posted (resumability guard)
// ═══════════════════════════════════════════════════════════════════════════════

test('#631 X uploadFile throw → ComposioToolError → publishNeverReachedPlatform true (safe rollback)', async () => {
  const gateway = makeXGateway({
    uploadFileShouldThrow: new Error('S3 staging failed: connection refused'),
  });

  const provider = new ComposioPublisherProvider(
    gateway,
    xFakeConfig(X_ACTIONS),
    fakeDb(),
  );

  let caught: unknown;
  try {
    await provider.publishPost({
      tenantId,
      platform: 'x',
      content: 'hi',
      mediaUrls: ['https://img.example.com/photo.png'],
      approved: true,
    });
    assert.fail('expected rejection');
  } catch (e) {
    caught = e;
  }

  // Wrapped in ComposioToolError → definitely-never-posted
  assert.ok(caught instanceof ComposioToolError, 'uploadFile throw must be wrapped in ComposioToolError');
  assert.equal(
    publishNeverReachedPlatform(caught),
    true,
    'uploadFile failure must be classified as definitely-never-posted (safe to retry/rollback)',
  );
  // No tweet was created
  assert.equal(
    gateway.calls.filter((c) => c.slug === 'TWITTER_CREATION_OF_A_POST').length,
    0,
    'create-post call must not be made when upload fails',
  );
});

test('#631 X TWITTER_UPLOAD_MEDIA returns successful:false → ComposioToolError → publishNeverReachedPlatform true', async () => {
  const gateway = makeXGateway({
    slugResults: new Map([
      [
        'TWITTER_UPLOAD_MEDIA',
        { data: null, successful: false, error: 'unsupported_media_type' },
      ],
    ]),
  });

  const provider = new ComposioPublisherProvider(
    gateway,
    xFakeConfig(X_ACTIONS),
    fakeDb(),
  );

  let caught: unknown;
  try {
    await provider.publishPost({
      tenantId,
      platform: 'x',
      content: 'hi',
      mediaUrls: ['https://img.example.com/photo.png'],
      approved: true,
    });
    assert.fail('expected rejection');
  } catch (e) {
    caught = e;
  }

  assert.ok(caught instanceof ComposioToolError, 'upload unsuccessful must throw ComposioToolError');
  assert.equal(
    publishNeverReachedPlatform(caught),
    true,
    'upload executeTool failure must be definitely-never-posted',
  );
  // The create-post call must NOT have been made (the tweet never existed)
  assert.equal(
    gateway.calls.filter((c) => c.slug === 'TWITTER_CREATION_OF_A_POST').length,
    0,
    'create-post must not be called after a failed upload',
  );
});

test('#631 X TWITTER_UPLOAD_MEDIA returns no media id → ComposioToolError (never-posted)', async () => {
  // Upload succeeds (successful:true) but returns no recognisable media id —
  // still before any tweet was created, so definitely-never-posted.
  const gateway = makeXGateway({
    slugResults: new Map([
      [
        'TWITTER_UPLOAD_MEDIA',
        { data: { status: 'pending' /* no id field */ }, successful: true, error: null },
      ],
    ]),
  });

  const provider = new ComposioPublisherProvider(
    gateway,
    xFakeConfig(X_ACTIONS),
    fakeDb(),
  );

  let caught: unknown;
  try {
    await provider.publishPost({
      tenantId,
      platform: 'x',
      content: 'hi',
      mediaUrls: ['https://img.example.com/photo.png'],
      approved: true,
    });
    assert.fail('expected rejection');
  } catch (e) {
    caught = e;
  }

  assert.ok(caught instanceof ComposioToolError, 'no media id after upload must throw ComposioToolError');
  assert.equal(
    publishNeverReachedPlatform(caught),
    true,
    'missing media id is still definitely-never-posted (tweet never created)',
  );
});

test('#631 X TWITTER_CREATION_OF_A_POST throw after successful upload is NOT definitely-never-posted (outcome-unknown boundary)', async () => {
  // The upload succeeds; the create-post call itself throws a raw network error.
  // At this point the tweet MAY have gone through (the POST was dispatched), so
  // the dispatcher MUST classify this as outcome-unknown — NOT safe to auto-retry.
  const gateway = makeXGateway({
    slugResults: new Map([
      ['TWITTER_UPLOAD_MEDIA', { data: { media_id_string: 'mid_ok' }, successful: true, error: null }],
    ]),
    defaultResult: { data: {}, successful: true, error: null },
  });
  // Override executeTool to throw only on the create slug
  const origExecute = gateway.executeTool.bind(gateway);
  gateway.executeTool = async (slug, opts) => {
    if (slug === 'TWITTER_CREATION_OF_A_POST') {
      throw new Error('ECONNRESET talking to the broker');
    }
    return origExecute(slug, opts);
  };

  const provider = new ComposioPublisherProvider(
    gateway,
    xFakeConfig(X_ACTIONS),
    fakeDb(),
  );

  let caught: unknown;
  try {
    await provider.publishPost({
      tenantId,
      platform: 'x',
      content: 'hi',
      mediaUrls: ['https://img.example.com/photo.png'],
      approved: true,
    });
    assert.fail('expected rejection');
  } catch (e) {
    caught = e;
  }

  // A raw error from the final create call is NOT a ComposioToolError.
  // publishNeverReachedPlatform must return false so callers treat it as
  // outcome-unknown (NOT auto-retried to avoid duplicate tweets).
  assert.ok(caught instanceof Error && !(caught instanceof ComposioToolError),
    'create-call throw must NOT be wrapped in ComposioToolError (callers must treat it as outcome-unknown)');
  assert.equal(
    publishNeverReachedPlatform(caught),
    false,
    'create-call throw is outcome-unknown, NOT definitely-never-posted',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. X connection missing → ComposioConnectionMissingError (parity with FB/IG)
// ═══════════════════════════════════════════════════════════════════════════════

test('#631 X with no active connection throws ComposioConnectionMissingError', async () => {
  const provider = new ComposioPublisherProvider(
    makeXGateway(),
    xFakeConfig(X_ACTIONS),
    fakeDb({ connectionRow: null }),
  );

  await assert.rejects(
    () =>
      provider.publishPost({
        tenantId,
        platform: 'x',
        content: 'hi',
        mediaUrls: [],
        approved: true,
      }),
    ComposioConnectionMissingError,
    'missing X connection must throw ComposioConnectionMissingError',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7a. normalizeTargetPlatforms dormancy
// ═══════════════════════════════════════════════════════════════════════════════

test('#631 normalizeTargetPlatforms: flag OFF → [\'x\'] returns null (x is not accepted)', async () => {
  await withEnv({ ARIES_X_ENABLED: undefined }, () => {
    const result = normalizeTargetPlatforms(['x']);
    assert.equal(
      result,
      null,
      "['x'] must return null when ARIES_X_ENABLED is unset (schedule request would 400)",
    );
  });
});

test('#631 normalizeTargetPlatforms: flag OFF → [\'facebook\', \'instagram\'] still accepted', async () => {
  await withEnv({ ARIES_X_ENABLED: undefined }, () => {
    const result = normalizeTargetPlatforms(['facebook', 'instagram']);
    assert.deepEqual(result, ['facebook', 'instagram'], 'facebook+instagram must work regardless of x flag');
  });
});

test('#631 normalizeTargetPlatforms: flag ON → [\'x\'] accepted', async () => {
  await withEnv({ ARIES_X_ENABLED: '1' }, () => {
    const result = normalizeTargetPlatforms(['x']);
    assert.deepEqual(result, ['x'], "['x'] must be accepted when ARIES_X_ENABLED=1");
  });
});

test('#631 normalizeTargetPlatforms: flag ON → [\'facebook\', \'instagram\', \'x\'] accepted', async () => {
  await withEnv({ ARIES_X_ENABLED: '1' }, () => {
    const result = normalizeTargetPlatforms(['facebook', 'instagram', 'x']);
    assert.deepEqual(result, ['facebook', 'instagram', 'x'], 'all three platforms valid when flag ON');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7b. Scheduled-dispatch guard predicates
// ═══════════════════════════════════════════════════════════════════════════════

test('#631 dispatch guard: isMetaProvider(x) is false — x is never routed via the direct-Meta fast path', () => {
  assert.equal(
    isMetaProvider('x'),
    false,
    "x must not be a Meta provider — a bug here would route X posts to a Facebook Page",
  );
});

test('#631 dispatch guard flag-OFF: combined predicate rejects x as unsupported_provider', async () => {
  // This replicates the exact condition in scheduled-dispatch/route.ts:
  //   const isXPublish = platform === 'x' && isXEnabled();
  //   if (!isMetaProvider(platform) && !isXPublish) → push unsupported_provider
  await withEnv({ ARIES_X_ENABLED: undefined }, () => {
    const platform = 'x';
    const isXPublish = platform === 'x' && isXEnabled();
    const shouldReject = !isMetaProvider(platform) && !isXPublish;
    assert.equal(
      shouldReject,
      true,
      'x must be rejected (unsupported_provider) when ARIES_X_ENABLED is unset',
    );
  });
});

test('#631 dispatch guard flag-ON: combined predicate passes x through to dispatchPublish', async () => {
  await withEnv({ ARIES_X_ENABLED: '1' }, () => {
    const platform = 'x';
    const isXPublish = platform === 'x' && isXEnabled();
    const shouldReject = !isMetaProvider(platform) && !isXPublish;
    assert.equal(
      shouldReject,
      false,
      'x must NOT be rejected when ARIES_X_ENABLED=1',
    );
  });
});

test('#631 dispatch guard: facebook/instagram pass regardless of x flag (no regression)', async () => {
  // Verifies that gating X does not accidentally break the FB/IG fast path.
  for (const platform of ['facebook', 'instagram'] as const) {
    assert.equal(
      isMetaProvider(platform),
      true,
      `${platform} must remain a Meta provider unaffected by the X flag`,
    );
    // The isMetaProvider check alone passes → shouldReject is false for FB/IG
    assert.equal(!isMetaProvider(platform), false, `${platform} must pass the Meta guard`);
  }
});
