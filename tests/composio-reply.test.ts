import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  replyToCommentViaComposio,
  shouldUseComposioReply,
  DEFAULT_FB_CREATE_COMMENT_SLUG,
} from '@/backend/integrations/composio/composio-reply';
import { MetaPublishError, classifyMetaPublishFailure } from '@/backend/integrations/meta-publishing';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

const baseReq = {
  tenantId: '42',
  provider: 'facebook',
  // Compound "{post_story_fbid}_{comment_id}" format as stored by the sync adapter.
  externalCommentId: 'PAGE123_777_888',
  message: 'Thanks for the kind words!',
};

// ── shouldUseComposioReply (provider selection) ─────────────────────────────────

test('shouldUseComposioReply: FB + composio enabled+selected → true', () => {
  assert.equal(
    shouldUseComposioReply('facebook', { COMPOSIO_ENABLED: 'true', PUBLISH_PROVIDER: 'composio' }),
    true,
  );
});

test('shouldUseComposioReply: FB but direct_meta → false (direct-Graph path)', () => {
  assert.equal(shouldUseComposioReply('facebook', { COMPOSIO_ENABLED: 'true', PUBLISH_PROVIDER: 'direct_meta' }), false);
  assert.equal(shouldUseComposioReply('facebook', {}), false);
});

test('shouldUseComposioReply: composio selected but master switch OFF → false', () => {
  // effectivePublishProvider forces direct_meta when COMPOSIO_ENABLED is off.
  assert.equal(shouldUseComposioReply('facebook', { PUBLISH_PROVIDER: 'composio' }), false);
});

test('shouldUseComposioReply: instagram is never routed via Composio (no verified action)', () => {
  assert.equal(shouldUseComposioReply('instagram', { COMPOSIO_ENABLED: 'true', PUBLISH_PROVIDER: 'composio' }), false);
});

// ── replyToCommentViaComposio ───────────────────────────────────────────────────

test('success: strips compound external_comment_id to trailing comment id and calls FACEBOOK_CREATE_COMMENT', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 'fb_reply_1' } },
  });
  const out = await replyToCommentViaComposio(baseReq, {}, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });

  assert.equal(out.platformReplyId, 'fb_reply_1');
  assert.equal(out.provider, 'facebook');
  assert.equal(gateway.calls[0].slug, DEFAULT_FB_CREATE_COMMENT_SLUG);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_123'); // from the connected row
  // object_id must be the TRAILING segment ("888"), not the full compound id.
  // Composio misparses compound ids as {pageId}_{...} and ignores any page_id arg.
  assert.deepEqual(gateway.calls[0].options.arguments, {
    object_id: '888',
    message: 'Thanks for the kind words!',
  });
});

// ── Regression test for #621 ───────────────────────────────────────────────────

test('regression #621: object_id passed to Composio is the trailing comment id, not the compound post_story_fbid prefix', async () => {
  // Exact prod values: external_comment_id = "{post_story_fbid}_{comment_id}".
  // The wrong shape (compound) caused Composio to extract the post_story_fbid
  // (122127913887202465) as the page id and fail with a 502 "page not found".
  const prodReq = {
    tenantId: '15',
    provider: 'facebook',
    externalCommentId: '122127913887202465_1712931046569911',
    message: 'Thanks!',
  };
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 'fb_reply_prod' } },
  });

  await replyToCommentViaComposio(prodReq, {}, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });

  const args = gateway.calls[0].options.arguments as Record<string, string>;

  // Must be the trailing comment id, NOT the compound id or the post_story_fbid.
  assert.equal(args.object_id, '1712931046569911',
    'object_id must be the trailing comment-own id');
  assert.notEqual(args.object_id, '122127913887202465_1712931046569911',
    'object_id must NOT be the compound id');
  assert.notEqual(args.object_id, '122127913887202465',
    'object_id must NOT be the post_story_fbid prefix');
});

test('single-segment comment id passes through unchanged', async () => {
  // When external_comment_id is already a plain id (no compound format),
  // it must be passed as-is — never truncated.
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 'fb_reply_plain' } },
  });
  await replyToCommentViaComposio(
    { ...baseReq, externalCommentId: '9876543210' },
    {},
    { gateway, config: fakeConfig({ actions: {} }), db: fakeDb() },
  );
  assert.equal(
    (gateway.calls[0].options.arguments as Record<string, string>).object_id,
    '9876543210',
    'plain id must not be modified',
  );
});

// ── Remaining existing tests (unchanged behaviour) ─────────────────────────────

test('success: reads a nested data.data.id wrapper too', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: { id: 'fb_reply_nested' } } },
  });
  const out = await replyToCommentViaComposio(baseReq, {}, { gateway, config: fakeConfig({ actions: {} }), db: fakeDb() });
  assert.equal(out.platformReplyId, 'fb_reply_nested');
});

test('explicit failure (successful:false) → MetaPublishError classified as DEFINITELY-never-posted (safe rollback)', async () => {
  const gateway = fakeGateway({ executeResult: { successful: false, error: 'object not accessible', data: null } });
  await assert.rejects(
    () => replyToCommentViaComposio(baseReq, {}, { gateway, config: fakeConfig({ actions: {} }), db: fakeDb() }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_failed');
      assert.equal(err.outcomeUnknown, false);
      assert.equal(classifyMetaPublishFailure(err), 'definitely_never_posted');
      return true;
    },
  );
});

test('2xx without a comment id → MetaPublishError outcomeUnknown (no rollback, no auto-retry)', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: {} } });
  await assert.rejects(
    () => replyToCommentViaComposio(baseReq, {}, { gateway, config: fakeConfig({ actions: {} }), db: fakeDb() }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_missing_id');
      assert.equal(err.outcomeUnknown, true);
      assert.equal(classifyMetaPublishFailure(err), 'outcome_unknown');
      return true;
    },
  );
});

test('transport error (gateway throws) → outcomeUnknown (the reply may have posted)', async () => {
  const gateway = {
    ...fakeGateway(),
    async executeTool() {
      throw new Error('ECONNRESET talking to Composio');
    },
  };
  await assert.rejects(
    () => replyToCommentViaComposio(baseReq, {}, { gateway, config: fakeConfig({ actions: {} }), db: fakeDb() }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_unconfirmed');
      assert.equal(err.outcomeUnknown, true);
      return true;
    },
  );
});

test('no active connection → oauth_token_missing (definite, surfaced as reconnect)', async () => {
  const gateway = fakeGateway();
  await assert.rejects(
    () => replyToCommentViaComposio(baseReq, {}, { gateway, config: fakeConfig({ actions: {} }), db: fakeDb({ connectionRow: null }) }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'oauth_token_missing');
      assert.equal(err.outcomeUnknown, false);
      return true;
    },
  );
  assert.equal(gateway.calls.length, 0, 'no tool call without a connection');
});

test('an env/config override replaces the default reply slug', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { id: 'x' } } });
  await replyToCommentViaComposio(baseReq, {}, {
    gateway,
    config: fakeConfig({ actions: { reply_comment: 'CUSTOM_REPLY_ACTION' } }),
    db: fakeDb(),
  });
  assert.equal(gateway.calls[0].slug, 'CUSTOM_REPLY_ACTION');
});

test('empty reply text is rejected before any tool call', async () => {
  const gateway = fakeGateway();
  await assert.rejects(
    () => replyToCommentViaComposio({ ...baseReq, message: '   ' }, {}, { gateway, config: fakeConfig({ actions: {} }), db: fakeDb() }),
    (err: unknown) => err instanceof MetaPublishError && err.code === 'missing_reply_text',
  );
  assert.equal(gateway.calls.length, 0);
});
