import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import { handleReplyToComment } from '../app/api/insights/comments/[commentId]/reply/handler';
import type { TenantContext } from '../lib/tenant-context';
import type { TenantContextLoader } from '../lib/tenant-context-http';
import type { MetaReplyRequest } from '../backend/integrations/meta-reply';

// Routes the FB reply through Composio when PUBLISH_PROVIDER=composio, reusing the
// exact claim/stamp/rollback handling. Composio is injected via deps.composioReply
// so no real gateway/SDK is built.

const COMPOSIO_ENV = {
  ARIES_NATIVE_REPLY_ENABLED: '1',
  COMPOSIO_ENABLED: 'true',
  PUBLISH_PROVIDER: 'composio',
} as const;

function tenantLoader(tenantId: number): TenantContextLoader {
  return async () =>
    ({ tenantId: String(tenantId), tenantSlug: 'test', role: 'tenant_admin' } as unknown as TenantContext);
}

function replyRequest(replyText: string): Request {
  return new Request('http://localhost/api/insights/comments/5/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reply_text: replyText }),
  });
}

type CommentRow = {
  id: number;
  tenant_id: number;
  platform: string;
  external_comment_id: string;
  is_replied: boolean;
  platform_reply_id: string | null;
};

function makeFakeCommentDb(initial: CommentRow) {
  const state = { ...initial };
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (norm.startsWith('SELECT')) {
      const [id, tenantId] = params as [number, number];
      if (state.id === id && state.tenant_id === tenantId) {
        return { rows: [{ id: state.id, platform: state.platform, external_comment_id: state.external_comment_id, is_replied: state.is_replied }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (norm.includes('SET is_replied = true')) {
      if (!state.is_replied) { state.is_replied = true; return { rows: [{ id: state.id }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (norm.includes('SET platform_reply_id = $1')) {
      state.platform_reply_id = (params as [string])[0];
      return { rows: [{ replied_at: new Date().toISOString() }], rowCount: 1 };
    }
    if (norm.includes('SET is_replied = false')) {
      state.is_replied = false;
      state.platform_reply_id = null;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected sql: ${norm}`);
  };
  return { db: { query } as unknown as Pool, state, calls };
}

const fbComment = (): CommentRow => ({
  id: 5,
  tenant_id: 12,
  platform: 'facebook',
  external_comment_id: 'PAGE_777_888',
  is_replied: false,
  platform_reply_id: null,
});

test('FB + PUBLISH_PROVIDER=composio routes through the Composio reply path and stamps the id', async () => {
  const { db, state } = makeFakeCommentDb(fbComment());
  const seen: MetaReplyRequest[] = [];
  const composioReply = async (req: MetaReplyRequest) => {
    seen.push(req);
    return { provider: 'facebook' as const, platformReplyId: 'fb_reply_99', connectionId: 'ca_1' };
  };
  // If the direct path were taken, this fetch would throw the test.
  const fetchImpl = (async () => { throw new Error('direct Graph must not be called under composio'); }) as typeof fetch;

  const res = await handleReplyToComment(replyRequest('Thanks!'), '5', {
    env: COMPOSIO_ENV,
    db,
    fetchImpl,
    composioReply,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; platform_reply_id: string };
  assert.equal(body.status, 'replied');
  assert.equal(body.platform_reply_id, 'fb_reply_99');
  assert.equal(state.platform_reply_id, 'fb_reply_99');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].externalCommentId, 'PAGE_777_888');
  assert.equal(seen[0].provider, 'facebook');
});

test('Composio outcome-unknown failure leaves the claim (no rollback) → needs_manual_reconciliation', async () => {
  const { db, state } = makeFakeCommentDb(fbComment());
  const { MetaPublishError } = await import('../backend/integrations/meta-publishing');
  const composioReply = async () => {
    throw new MetaPublishError('composio_reply_missing_id', 'accepted, no id', { status: 502, outcomeUnknown: true });
  };

  const res = await handleReplyToComment(replyRequest('Thanks!'), '5', {
    env: COMPOSIO_ENV,
    db,
    composioReply,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 502);
  assert.equal((await res.json()).status, 'needs_manual_reconciliation');
  assert.equal(state.is_replied, true, 'claim is NOT rolled back on outcome-unknown');
});

test('Composio explicit failure rolls the claim back so a retry can re-attempt', async () => {
  const { db, state } = makeFakeCommentDb(fbComment());
  const { MetaPublishError } = await import('../backend/integrations/meta-publishing');
  const composioReply = async () => {
    throw new MetaPublishError('composio_reply_failed', 'object not accessible', { status: 502, retryable: false });
  };

  const res = await handleReplyToComment(replyRequest('Thanks!'), '5', {
    env: COMPOSIO_ENV,
    db,
    composioReply,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 502);
  assert.equal(state.is_replied, false, 'claim rolled back on a definite failure');
  assert.equal(state.platform_reply_id, null);
});

// ── New-platform dormancy (per-platform ARIES_<P>_ENABLED OFF → 422) ─────────
//
// When a platform's rollout flag is off, a stored comment of that platform → the
// route returns 422 reply_not_supported and never reaches the Composio dispatch
// (no pre-claim UPDATE is issued). The master ARIES_NATIVE_REPLY_ENABLED OFF
// case → 404 is also guarded here for new-platform context.

const BASE_ENV_NO_PLATFORM = {
  ARIES_NATIVE_REPLY_ENABLED: '1',
  COMPOSIO_ENABLED: 'true',
  // Intentionally NO ARIES_X_ENABLED / ARIES_YOUTUBE_ENABLED / ARIES_REDDIT_ENABLED / ARIES_LINKEDIN_ENABLED.
} as const;

function newPlatformComment(platform: string): CommentRow {
  return {
    id: 5,
    tenant_id: 12,
    platform,
    external_comment_id: `${platform}_ext_1`,
    is_replied: false,
    platform_reply_id: null,
  };
}

test('X: ARIES_X_ENABLED OFF → 422 reply_not_supported, no pre-claim UPDATE issued', async () => {
  const { db, calls } = makeFakeCommentDb(newPlatformComment('x'));

  const res = await handleReplyToComment(replyRequest('Hello!'), '5', {
    env: BASE_ENV_NO_PLATFORM,
    db,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 422);
  assert.equal((await res.json()).reason, 'reply_not_supported');
  const updateCalls = calls.filter(c => c.sql.includes('SET is_replied'));
  assert.equal(updateCalls.length, 0, 'no claim UPDATE when X platform is dormant');
});

test('YouTube: ARIES_YOUTUBE_ENABLED OFF → 422 reply_not_supported, no pre-claim UPDATE issued', async () => {
  const { db, calls } = makeFakeCommentDb(newPlatformComment('youtube'));

  const res = await handleReplyToComment(replyRequest('Hello!'), '5', {
    env: BASE_ENV_NO_PLATFORM,
    db,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 422);
  assert.equal((await res.json()).reason, 'reply_not_supported');
  const updateCalls = calls.filter(c => c.sql.includes('SET is_replied'));
  assert.equal(updateCalls.length, 0, 'no claim UPDATE when YouTube platform is dormant');
});

test('Reddit: ARIES_REDDIT_ENABLED OFF → 422 reply_not_supported, no pre-claim UPDATE issued', async () => {
  const { db, calls } = makeFakeCommentDb(newPlatformComment('reddit'));

  const res = await handleReplyToComment(replyRequest('Hello!'), '5', {
    env: BASE_ENV_NO_PLATFORM,
    db,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 422);
  assert.equal((await res.json()).reason, 'reply_not_supported');
  const updateCalls = calls.filter(c => c.sql.includes('SET is_replied'));
  assert.equal(updateCalls.length, 0, 'no claim UPDATE when Reddit platform is dormant');
});

test('LinkedIn: ARIES_LINKEDIN_ENABLED OFF → 422 reply_not_supported, no pre-claim UPDATE issued', async () => {
  const { db, calls } = makeFakeCommentDb(newPlatformComment('linkedin'));

  const res = await handleReplyToComment(replyRequest('Hello!'), '5', {
    env: BASE_ENV_NO_PLATFORM,
    db,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 422);
  assert.equal((await res.json()).reason, 'reply_not_supported');
  const updateCalls = calls.filter(c => c.sql.includes('SET is_replied'));
  assert.equal(updateCalls.length, 0, 'no claim UPDATE when LinkedIn platform is dormant');
});

test('ARIES_NATIVE_REPLY_ENABLED OFF with an X comment → 404 (route is invisible)', async () => {
  let dbCalls = 0;
  const db = {
    query: async () => {
      dbCalls += 1;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  const res = await handleReplyToComment(replyRequest('Hello!'), '5', {
    env: {}, // master switch OFF
    db,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 404);
  assert.equal((await res.json()).reason, 'not_found');
  assert.equal(dbCalls, 0, 'no DB access when master flag is OFF');
});
