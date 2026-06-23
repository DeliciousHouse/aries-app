/**
 * Unit-level regression coverage for the new-platform (X / YouTube / Reddit /
 * LinkedIn) Composio reply dispatch added in #634 / #639 / #644 / #649.
 *
 * Covers:
 *   1. isComposioReplyPlatform flag routing.
 *   2. Per-platform correct slug + argument construction + id extraction.
 *   3. Idempotency classification: definitely_never_posted vs outcome_unknown.
 *   4. Reddit rate-limit divergence (transport 429 → rollback-safe, NOT outcome-unknown).
 *   5. Reddit t1_ no-double-prefix invariant (load-bearing #634).
 *   6. LinkedIn actor/object guard (missing URNs → typed rollback errors).
 *
 * Self-contained: uses fakeGateway + fakeConfig + fakeDb from tests/composio/helpers.
 * No real Postgres, no real Composio SDK.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isComposioReplyPlatform,
  replyToCommentViaComposioForPlatform,
  DEFAULT_COMPOSIO_REPLY_SLUG,
} from '@/backend/integrations/composio/composio-reply';
import { MetaPublishError, classifyMetaPublishFailure } from '@/backend/integrations/meta-publishing';
import { fakeConfig, fakeGateway, fakeDb } from './composio/helpers';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Full connected_accounts row shape that fakeDb can return. */
function connectionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tenant_id: 42,
    external_user_id: 'u42',
    platform: 'linkedin',
    provider: 'composio',
    connected_account_id: 'ca_main',
    auth_config_id: 'ac_main',
    external_account_id: 'ext_1', // LinkedIn actor URN by default
    external_account_name: 'Test User',
    status: 'connected',
    capabilities_json: null,
    last_capability_check_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides,
  };
}

/** No platform flags in env — config is injected via deps so env is irrelevant. */
const ENV = {} as Record<string, string>;

// ═══════════════════════════════════════════════════════════════════════════════
// 1. isComposioReplyPlatform — per-platform flag routing
// ═══════════════════════════════════════════════════════════════════════════════

test('isComposioReplyPlatform: X enabled (ARIES_X_ENABLED=1) → true', () => {
  assert.equal(isComposioReplyPlatform('x', { ARIES_X_ENABLED: '1' }), true);
});
test('isComposioReplyPlatform: X off (no flag) → false', () => {
  assert.equal(isComposioReplyPlatform('x', {}), false);
});
test('isComposioReplyPlatform: YouTube enabled (ARIES_YOUTUBE_ENABLED=1) → true', () => {
  assert.equal(isComposioReplyPlatform('youtube', { ARIES_YOUTUBE_ENABLED: '1' }), true);
});
test('isComposioReplyPlatform: YouTube off → false', () => {
  assert.equal(isComposioReplyPlatform('youtube', {}), false);
});
test('isComposioReplyPlatform: Reddit enabled (ARIES_REDDIT_ENABLED=1) → true', () => {
  assert.equal(isComposioReplyPlatform('reddit', { ARIES_REDDIT_ENABLED: '1' }), true);
});
test('isComposioReplyPlatform: Reddit off → false', () => {
  assert.equal(isComposioReplyPlatform('reddit', {}), false);
});
test('isComposioReplyPlatform: LinkedIn enabled (ARIES_LINKEDIN_ENABLED=1) → true', () => {
  assert.equal(isComposioReplyPlatform('linkedin', { ARIES_LINKEDIN_ENABLED: '1' }), true);
});
test('isComposioReplyPlatform: LinkedIn off → false', () => {
  assert.equal(isComposioReplyPlatform('linkedin', {}), false);
});
test('isComposioReplyPlatform: facebook → always false (handled by shouldUseComposioReply)', () => {
  // Facebook is not in the new-platform set — its routing lives in shouldUseComposioReply.
  assert.equal(
    isComposioReplyPlatform('facebook', {
      COMPOSIO_ENABLED: 'true',
      PUBLISH_PROVIDER: 'composio',
    }),
    false,
  );
});
test('isComposioReplyPlatform: unknown platform → false', () => {
  assert.equal(isComposioReplyPlatform('snapchat', { ARIES_X_ENABLED: '1' }), false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. X dispatch
// ═══════════════════════════════════════════════════════════════════════════════

const xReq = {
  tenantId: '42',
  provider: 'x',
  externalCommentId: 'tweet_id_123',
  message: 'Great tweet!',
};

test('X: correct slug (TWITTER_CREATION_OF_A_POST) and args {text, reply_in_reply_to_tweet_id}', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { id: 'x_reply_1' } } });
  const out = await replyToCommentViaComposioForPlatform(xReq, 'x', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });

  assert.equal(out.platformReplyId, 'x_reply_1');
  assert.equal(out.connectionId, 'ca_123');
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].slug, DEFAULT_COMPOSIO_REPLY_SLUG.x);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_123');
  assert.deepEqual(gateway.calls[0].options.arguments, {
    text: 'Great tweet!',
    reply_in_reply_to_tweet_id: 'tweet_id_123',
  });
});

test('X: successful:false → definitely_never_posted (safe rollback)', async () => {
  const gateway = fakeGateway({ executeResult: { successful: false, error: 'not authorized', data: null } });
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(xReq, 'x', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_failed');
      assert.equal(err.outcomeUnknown, false);
      assert.equal(classifyMetaPublishFailure(err), 'definitely_never_posted');
      return true;
    },
  );
});

test('X: transport throw → outcomeUnknown (claim left, never auto-retry)', async () => {
  const gateway = { ...fakeGateway(), async executeTool() { throw new Error('ECONNRESET'); } };
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(xReq, 'x', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_unconfirmed');
      assert.equal(err.outcomeUnknown, true);
      assert.equal(classifyMetaPublishFailure(err), 'outcome_unknown');
      return true;
    },
  );
});

test('X: success + no reply id → outcomeUnknown', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: {} } });
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(xReq, 'x', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_missing_id');
      assert.equal(err.outcomeUnknown, true);
      return true;
    },
  );
});

test('X: no active connection → oauth_token_missing (never-posted, rollback safe)', async () => {
  const gateway = fakeGateway();
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(xReq, 'x', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb({ connectionRow: null }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'oauth_token_missing');
      assert.equal(err.outcomeUnknown, false);
      return true;
    },
  );
  assert.equal(gateway.calls.length, 0, 'no tool call without a connection');
});

test('X: empty reply text is rejected before any tool call', async () => {
  const gateway = fakeGateway();
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform({ ...xReq, message: '   ' }, 'x', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => err instanceof MetaPublishError && err.code === 'missing_reply_text',
  );
  assert.equal(gateway.calls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. YouTube dispatch
// ═══════════════════════════════════════════════════════════════════════════════

const ytReq = {
  tenantId: '42',
  provider: 'youtube',
  externalCommentId: 'UgxYT_comment_id',
  message: 'Nice video!',
};

test('YouTube: correct slug (YOUTUBE_CREATE_COMMENT_REPLY) and args {parentId, textOriginal}', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { id: 'yt_reply_1' } } });
  const out = await replyToCommentViaComposioForPlatform(ytReq, 'youtube', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });

  assert.equal(out.platformReplyId, 'yt_reply_1');
  assert.equal(gateway.calls[0].slug, DEFAULT_COMPOSIO_REPLY_SLUG.youtube);
  assert.deepEqual(gateway.calls[0].options.arguments, {
    parentId: 'UgxYT_comment_id',
    textOriginal: 'Nice video!',
  });
});

test('YouTube: success with nested data.id wrapper → extracted', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: { id: 'yt_nested_reply' } } },
  });
  const out = await replyToCommentViaComposioForPlatform(ytReq, 'youtube', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });
  assert.equal(out.platformReplyId, 'yt_nested_reply');
});

test('YouTube: successful:false → definitely_never_posted', async () => {
  const gateway = fakeGateway({ executeResult: { successful: false, error: 'forbidden', data: null } });
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(ytReq, 'youtube', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.outcomeUnknown, false);
      assert.equal(classifyMetaPublishFailure(err), 'definitely_never_posted');
      return true;
    },
  );
});

test('YouTube: transport throw → outcomeUnknown', async () => {
  const gateway = { ...fakeGateway(), async executeTool() { throw new Error('timeout'); } };
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(ytReq, 'youtube', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.outcomeUnknown, true);
      return true;
    },
  );
});

test('YouTube: success + no id → outcomeUnknown', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: {} } });
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(ytReq, 'youtube', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.outcomeUnknown, true);
      return true;
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Reddit dispatch — t1_ no-double-prefix + rate-limit divergence (load-bearing)
// ═══════════════════════════════════════════════════════════════════════════════

test('Reddit: pre-prefixed t1_ id is NOT double-prefixed (load-bearing #634)', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { name: 't1_abcdef' } } });
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abcdef', message: 'Great!' };
  await replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });

  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.thing_id, 't1_abcdef', 'pre-prefixed id must NOT be double-prefixed');
});

test('Reddit: bare base36 id gets t1_ prefix (load-bearing #634)', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { name: 't1_xyz789' } } });
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 'xyz789', message: 'ok' };
  await replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });

  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.thing_id, 't1_xyz789', 'bare id must be prefixed with t1_');
});

test('Reddit: correct slug (REDDIT_POST_REDDIT_COMMENT) and text arg', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { name: 't1_abc' } } });
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abc', message: 'Hello Reddit!' };
  await replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });
  assert.equal(gateway.calls[0].slug, DEFAULT_COMPOSIO_REPLY_SLUG.reddit);
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.text, 'Hello Reddit!');
});

test('Reddit: idKey order — data.name is preferred over data.id', async () => {
  // Both `name` and `id` are present; `name` must win (listed first in idKeys).
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { name: 't1_name_wins', id: 'fallback_id' } },
  });
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abc', message: 'ok' };
  const out = await replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });
  assert.equal(out.platformReplyId, 't1_name_wins');
});

test('Reddit: fallback to data.id when data.name absent', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 'fallback_id_only' } },
  });
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abc', message: 'ok' };
  const out = await replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });
  assert.equal(out.platformReplyId, 'fallback_id_only');
});

test('Reddit: successful:false → definitely_never_posted (rollback safe)', async () => {
  const gateway = fakeGateway({ executeResult: { successful: false, error: 'forbidden', data: null } });
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abc', message: 'ok' };
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_failed');
      assert.equal(err.outcomeUnknown, false);
      assert.equal(classifyMetaPublishFailure(err), 'definitely_never_posted');
      return true;
    },
  );
});

test('Reddit: non-rate-limit transport throw → outcomeUnknown (NOT rollback) — divergent assertion', async () => {
  // A generic transport drop (no 429/rate-limit keyword) is outcome-unknown for
  // Reddit too — the comment MAY have reached the API. This is the same as other
  // platforms; the divergence only applies to rate-limit errors (see next test).
  const gateway = { ...fakeGateway(), async executeTool() { throw new Error('ECONNRESET'); } };
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abc', message: 'ok' };
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_unconfirmed');
      assert.equal(
        err.outcomeUnknown,
        true,
        'non-rate-limit transport error must be outcome_unknown for Reddit too',
      );
      assert.equal(classifyMetaPublishFailure(err), 'outcome_unknown');
      return true;
    },
  );
});

test('Reddit: rate-limit transport throw (429 in message) → definitely_never_posted + retryable (load-bearing #634)', async () => {
  // A 429 means the API REJECTED the write — the comment was DEFINITELY never
  // created. This is rollback-safe and retryable, NOT outcome-unknown. This is
  // the key divergence from the generic transport-drop path.
  const gateway = {
    ...fakeGateway(),
    async executeTool() { throw new Error('Request failed with status 429 Too Many Requests'); },
  };
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abc', message: 'ok' };
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_rate_limited');
      assert.equal(err.outcomeUnknown, false, 'rate-limit must NOT be outcome-unknown');
      assert.equal(err.retryable, true, 'rate-limit is retryable after backoff');
      assert.equal(classifyMetaPublishFailure(err), 'definitely_never_posted');
      return true;
    },
  );
});

test('Reddit: "cooldown" in message → definitely_never_posted (load-bearing #634)', async () => {
  const gateway = {
    ...fakeGateway(),
    async executeTool() {
      throw new Error('you are doing that too much. try again in 8 minutes. (cooldown)');
    },
  };
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abc', message: 'ok' };
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_rate_limited');
      assert.equal(err.outcomeUnknown, false);
      return true;
    },
  );
});

test('Reddit: "rate limit" text in message → definitely_never_posted', async () => {
  const gateway = {
    ...fakeGateway(),
    async executeTool() { throw new Error('rate limit exceeded, please back off'); },
  };
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abc', message: 'ok' };
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'composio_reply_rate_limited');
      assert.equal(err.outcomeUnknown, false);
      return true;
    },
  );
});

test('Reddit: success + no id → outcomeUnknown', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: {} } });
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abc', message: 'ok' };
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.outcomeUnknown, true);
      return true;
    },
  );
});

test('Reddit: no active connection → oauth_token_missing', async () => {
  const gateway = fakeGateway();
  const req = { tenantId: '42', provider: 'reddit', externalCommentId: 't1_abc', message: 'ok' };
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(req, 'reddit', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb({ connectionRow: null }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'oauth_token_missing');
      assert.equal(err.outcomeUnknown, false);
      return true;
    },
  );
  assert.equal(gateway.calls.length, 0, 'no tool call without a connection');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. LinkedIn dispatch — actor/object guards + idKey order + clamp
// ═══════════════════════════════════════════════════════════════════════════════

const liReq = {
  tenantId: '42',
  provider: 'linkedin',
  externalCommentId: 'urn:li:comment:789',
  externalPostId: 'urn:li:share:456',
  message: 'Insightful post!',
};

// Default fakeDb has external_account_id: 'ext_1' (actor URN).
test('LinkedIn: correct slug (LINKEDIN_CREATE_COMMENT_ON_POST) + args (actor/object/message.text + parentComment)', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { commentUrn: 'urn:li:comment:new_1' } },
  });
  const out = await replyToCommentViaComposioForPlatform(liReq, 'linkedin', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });

  assert.equal(out.platformReplyId, 'urn:li:comment:new_1');
  assert.equal(gateway.calls[0].slug, DEFAULT_COMPOSIO_REPLY_SLUG.linkedin);
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal(args.actor, 'ext_1', 'actor must come from conn.externalAccountId');
  assert.equal(args.object, 'urn:li:share:456', 'object must be the post URN (externalPostId)');
  assert.deepEqual(args.message, { text: 'Insightful post!' });
  assert.equal(args.parentComment, 'urn:li:comment:789', 'parentComment = the stored comment URN');
});

test('LinkedIn: empty externalCommentId → parentComment omitted (top-level comment reply)', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { commentUrn: 'urn:li:comment:top' } },
  });
  const req = { ...liReq, externalCommentId: '' };
  await replyToCommentViaComposioForPlatform(req, 'linkedin', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  assert.equal('parentComment' in args, false, 'parentComment must be absent when no comment URN');
});

test('LinkedIn: long message is clamped at 1250 chars with ellipsis', async () => {
  const longMsg = 'x'.repeat(1300);
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { commentUrn: 'urn:li:comment:clamped' } },
  });
  const req = { ...liReq, message: longMsg };
  await replyToCommentViaComposioForPlatform(req, 'linkedin', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  const sent = (args.message as { text: string }).text;
  assert.equal(sent.length, 1250, 'clamped to exactly 1250 chars');
  assert.ok(sent.endsWith('…'), 'clamped message must end with ellipsis glyph');
});

test('LinkedIn: message at exactly 1250 chars is not clamped', async () => {
  const exactMsg = 'y'.repeat(1250);
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { commentUrn: 'urn:li:comment:exact' } },
  });
  const req = { ...liReq, message: exactMsg };
  await replyToCommentViaComposioForPlatform(req, 'linkedin', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });
  const args = gateway.calls[0].options.arguments as Record<string, unknown>;
  const sent = (args.message as { text: string }).text;
  assert.equal(sent.length, 1250);
  assert.ok(!sent.endsWith('…'), '1250-char message must NOT be truncated');
});

test('LinkedIn: missing externalPostId (no JOIN row) → reply_not_supported (never-posted, rollback safe)', async () => {
  const req = { ...liReq, externalPostId: null as string | null };
  const gateway = fakeGateway();
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(req, 'linkedin', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'reply_not_supported');
      assert.equal(err.outcomeUnknown, false);
      assert.equal(classifyMetaPublishFailure(err), 'definitely_never_posted');
      return true;
    },
  );
  assert.equal(gateway.calls.length, 0, 'no gateway call when object (post URN) is missing');
});

test('LinkedIn: missing actor (null externalAccountId) → oauth_token_missing (rollback safe)', async () => {
  const gateway = fakeGateway();
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(liReq, 'linkedin', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb({ connectionRow: connectionRow({ external_account_id: null }) }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'oauth_token_missing');
      assert.equal(err.outcomeUnknown, false);
      assert.equal(classifyMetaPublishFailure(err), 'definitely_never_posted');
      return true;
    },
  );
  assert.equal(gateway.calls.length, 0, 'no gateway call when actor URN is missing');
});

test('LinkedIn: idKey order — commentUrn wins over id wins over urn', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { commentUrn: 'urn:li:comment:winner', id: 'li_id', urn: 'urn:li:comment:third' },
    },
  });
  const out = await replyToCommentViaComposioForPlatform(liReq, 'linkedin', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });
  assert.equal(out.platformReplyId, 'urn:li:comment:winner');
});

test('LinkedIn: fallback to id when commentUrn absent', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 'li_id_fallback' } },
  });
  const out = await replyToCommentViaComposioForPlatform(liReq, 'linkedin', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });
  assert.equal(out.platformReplyId, 'li_id_fallback');
});

test('LinkedIn: fallback to urn when commentUrn + id absent', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { urn: 'urn:li:comment:urn_only' } },
  });
  const out = await replyToCommentViaComposioForPlatform(liReq, 'linkedin', ENV, {
    gateway,
    config: fakeConfig({ actions: {} }),
    db: fakeDb(),
  });
  assert.equal(out.platformReplyId, 'urn:li:comment:urn_only');
});

test('LinkedIn: successful:false → definitely_never_posted', async () => {
  const gateway = fakeGateway({ executeResult: { successful: false, error: 'access denied', data: null } });
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(liReq, 'linkedin', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.outcomeUnknown, false);
      assert.equal(classifyMetaPublishFailure(err), 'definitely_never_posted');
      return true;
    },
  );
});

test('LinkedIn: transport throw → outcomeUnknown', async () => {
  const gateway = { ...fakeGateway(), async executeTool() { throw new Error('network error'); } };
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(liReq, 'linkedin', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.outcomeUnknown, true);
      return true;
    },
  );
});

test('LinkedIn: success + no id → outcomeUnknown', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: {} } });
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(liReq, 'linkedin', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb(),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.outcomeUnknown, true);
      return true;
    },
  );
});

test('LinkedIn: no active connection → oauth_token_missing', async () => {
  const gateway = fakeGateway();
  await assert.rejects(
    () =>
      replyToCommentViaComposioForPlatform(liReq, 'linkedin', ENV, {
        gateway,
        config: fakeConfig({ actions: {} }),
        db: fakeDb({ connectionRow: null }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof MetaPublishError);
      assert.equal(err.code, 'oauth_token_missing');
      assert.equal(err.outcomeUnknown, false);
      return true;
    },
  );
  assert.equal(gateway.calls.length, 0, 'no tool call without a connection');
});
