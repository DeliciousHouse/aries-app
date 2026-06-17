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
  externalCommentId: 'PAGE123_777_888', // full graph comment id
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

test('success: builds FACEBOOK_CREATE_COMMENT with object_id+message and returns the created id', async () => {
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
  assert.deepEqual(gateway.calls[0].options.arguments, {
    object_id: 'PAGE123_777_888',
    message: 'Thanks for the kind words!',
  });
});

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
