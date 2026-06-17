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

test('success: builds FACEBOOK_CREATE_COMMENT with object_id+message+page_id and returns the created id', async () => {
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
  // page_id must be the stored externalAccountId ('ext_1' in fakeDb default),
  // NOT anything derived from the comment / object_id.
  assert.deepEqual(gateway.calls[0].options.arguments, {
    object_id: 'PAGE123_777_888',
    message: 'Thanks for the kind words!',
    page_id: 'ext_1',
  });
});

// ── Regression test for #621 ───────────────────────────────────────────────────

test('regression #621: page_id in FACEBOOK_CREATE_COMMENT is the connected page id, not a comment-id-derived value', async () => {
  // Realistic prod values from the bug report: comment id has 18 digits which
  // Composio was misreading as a page id (formatted with hyphens as the error
  // showed "page_id:12212-79138-87202-465"). The real page is 1002997576221948.
  const realisticReq = {
    tenantId: '15',
    provider: 'facebook',
    externalCommentId: '122127913887202465', // 18-digit comment id from prod
    message: 'Hi, thanks!',
  };
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 'fb_reply_prod_1' } },
  });
  const connectedPageId = '1002997576221948';
  const db = fakeDb({
    connectionRow: {
      id: 1,
      tenant_id: 15,
      external_user_id: 'aries-tenant-15',
      platform: 'facebook',
      provider: 'composio',
      connected_account_id: 'ca_ZbclZgZy4_q2',
      auth_config_id: 'auth_cfg_test',
      external_account_id: connectedPageId,
      external_account_name: 'Test FB Page',
      status: 'connected',
      capabilities_json: null,
      last_capability_check_at: null,
      created_at: new Date(0),
      updated_at: new Date(0),
    },
  });

  await replyToCommentViaComposio(realisticReq, {}, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db,
  });

  const args = gateway.calls[0].options.arguments as Record<string, string>;

  // page_id must be the connected page — 1002997576221948.
  assert.equal(args.page_id, connectedPageId, 'page_id must equal the connected page id');
  // page_id must NOT be any segment or permutation of the comment id.
  assert.ok(
    !args.page_id.includes(realisticReq.externalCommentId.slice(0, 5)),
    'page_id must not start with comment id digits',
  );
  // object_id must still be the full comment id.
  assert.equal(args.object_id, realisticReq.externalCommentId);
});

// ── Page-id resolution fallback path ───────────────────────────────────────────

test('FB reply resolves page id via FACEBOOK_LIST_MANAGED_PAGES when externalAccountId is null', async () => {
  const resolvedPageId = '9001002003004';
  // Gateway returns list-pages response on first call, reply success on second.
  const slugCalls: string[] = [];
  const customGateway = {
    ...fakeGateway(),
    async executeTool(slug: string, _opts: unknown) {
      slugCalls.push(slug);
      if (slug === 'FACEBOOK_LIST_MANAGED_PAGES') {
        // Composio response shape: { data: { data: [{ id, name }] } }
        return { successful: true, error: null, data: { data: { data: [{ id: resolvedPageId, name: 'Resolved Page' }] } } };
      }
      // FACEBOOK_CREATE_COMMENT
      return { successful: true, error: null, data: { id: 'fb_reply_resolved' } };
    },
  };
  const db = fakeDb({
    connectionRow: {
      id: 1,
      tenant_id: 42,
      external_user_id: 'aries-tenant-42',
      platform: 'facebook',
      provider: 'composio',
      connected_account_id: 'ca_123',
      auth_config_id: 'auth_cfg_test',
      external_account_id: null, // not stored — must be resolved dynamically
      external_account_name: null,
      status: 'connected',
      capabilities_json: null,
      last_capability_check_at: null,
      created_at: new Date(0),
      updated_at: new Date(0),
    },
  });

  const out = await replyToCommentViaComposio(baseReq, {}, {
    gateway: customGateway as ReturnType<typeof fakeGateway>,
    config: fakeConfig({ actions: {} }),
    db,
  });

  assert.equal(out.platformReplyId, 'fb_reply_resolved');
  assert.equal(slugCalls[0], 'FACEBOOK_LIST_MANAGED_PAGES', 'first call must be page resolution');
  assert.equal(slugCalls[1], DEFAULT_FB_CREATE_COMMENT_SLUG, 'second call must be the reply');
  // Verify the resolved page id was passed
  const replyCall = (customGateway as { calls?: Array<{ options: { arguments?: Record<string, unknown> } }> }).calls;
  if (replyCall && replyCall.length > 0) {
    const lastCall = replyCall[replyCall.length - 1];
    assert.equal(lastCall.options.arguments?.page_id, resolvedPageId);
  }
});

test('FB reply throws fb_page_id_missing when neither stored nor resolved page id is available', async () => {
  // Gateway returns an empty pages list for FACEBOOK_LIST_MANAGED_PAGES.
  const customGateway = {
    ...fakeGateway(),
    async executeTool(_slug: string, _opts: unknown) {
      return { successful: true, error: null, data: { data: { data: [] } } };
    },
  };
  const db = fakeDb({
    connectionRow: {
      id: 1,
      tenant_id: 42,
      external_user_id: 'aries-tenant-42',
      platform: 'facebook',
      provider: 'composio',
      connected_account_id: 'ca_123',
      auth_config_id: 'auth_cfg_test',
      external_account_id: null,
      external_account_name: null,
      status: 'connected',
      capabilities_json: null,
      last_capability_check_at: null,
      created_at: new Date(0),
      updated_at: new Date(0),
    },
  });

  await assert.rejects(
    () => replyToCommentViaComposio(baseReq, {}, {
      gateway: customGateway as ReturnType<typeof fakeGateway>,
      config: fakeConfig({ actions: {} }),
      db,
    }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'fb_page_id_missing');
      assert.equal(err.status, 409);
      return true;
    },
  );
});

// ── Remaining existing tests (unchanged) ───────────────────────────────────────

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
