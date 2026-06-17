import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import pool from '../lib/db';
import { handleReplyToComment } from '../app/api/insights/comments/[commentId]/reply/handler';
import { encryptOAuthSecret } from '../backend/integrations/oauth-token-crypto';
import type { TenantContext } from '../lib/tenant-context';
import type { TenantContextLoader } from '../lib/tenant-context-http';

// ── Fixtures ────────────────────────────────────────────────────────────────

const ENABLED = { ARIES_NATIVE_REPLY_ENABLED: '1' } as const;

function tenantLoader(tenantId: number): TenantContextLoader {
  return async () =>
    ({ tenantId: String(tenantId), tenantSlug: 'test', role: 'tenant_admin' } as unknown as TenantContext);
}

function replyRequest(replyText: unknown): Request {
  return new Request('http://localhost/api/insights/comments/5/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(replyText === undefined ? {} : { reply_text: replyText }),
  });
}

// In-memory insights_comments row backing a fake injected Pool. The handler runs
// independent pool.query calls (SELECT load, pre-claim UPDATE, success/rollback
// UPDATE); this fake routes each by SQL shape and enforces tenant scoping so the
// isolation test exercises the real WHERE tenant_id predicate.
type CommentRow = {
  id: number;
  tenant_id: number;
  platform: string;
  external_comment_id: string;
  is_replied: boolean;
  platform_reply_id: string | null;
  replied_at: string | null;
};

function makeFakeCommentDb(initial: CommentRow) {
  const state: CommentRow = { ...initial };
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const norm = sql.replace(/\s+/g, ' ').trim();

    if (norm.startsWith('SELECT')) {
      const [id, tenantId] = params as [number, number];
      if (state.id === id && state.tenant_id === tenantId) {
        return {
          rows: [
            {
              id: state.id,
              platform: state.platform,
              external_comment_id: state.external_comment_id,
              is_replied: state.is_replied,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('SET is_replied = true')) {
      const [id, tenantId] = params as [number, number];
      if (state.id === id && state.tenant_id === tenantId && state.is_replied === false) {
        state.is_replied = true;
        return { rows: [{ id: state.id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('SET platform_reply_id = $1')) {
      const [replyId, id, tenantId] = params as [string, number, number];
      if (state.id === id && state.tenant_id === tenantId) {
        state.platform_reply_id = replyId;
        state.replied_at = new Date().toISOString();
        return { rows: [{ replied_at: state.replied_at }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (norm.includes('SET is_replied = false')) {
      const [id, tenantId] = params as [number, number];
      if (state.id === id && state.tenant_id === tenantId) {
        state.is_replied = false;
        state.platform_reply_id = null;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`unexpected sql: ${norm}`);
  };

  return { db: { query } as unknown as Pool, state, calls };
}

// Monkeypatch the shared pool's oauth-token query (used by replyToComment's
// token lookup, which rides the real pool, not the injected deps.db).
function installTokenFixture(row: { access_token_enc: string | null; connection_id: string; external_account_id: string | null } | null) {
  const originalQuery = pool.query.bind(pool);
  (pool as typeof pool & { query: typeof pool.query }).query = (async () => ({
    rows: row ? [row] : [],
    rowCount: row ? 1 : 0,
    command: 'SELECT',
    oid: 0,
    fields: [],
  })) as unknown as typeof pool.query;
  return () => {
    (pool as typeof pool & { query: typeof pool.query }).query = originalQuery;
  };
}

function connectedToken() {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!';
  return installTokenFixture({
    access_token_enc: encryptOAuthSecret('ig-token'),
    connection_id: 'conn_ig',
    external_account_id: 'ig_acct',
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('flag OFF: returns a real 404 and touches neither DB nor Graph', async () => {
  let dbCalls = 0;
  let fetchCalls = 0;
  const db = { query: async () => { dbCalls += 1; return { rows: [], rowCount: 0 }; } } as unknown as Pool;
  const fetchImpl = (async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); }) as typeof fetch;

  const res = await handleReplyToComment(replyRequest('hi'), '5', {
    env: {},
    db,
    fetchImpl,
    tenantContextLoader: async () => { throw new Error('tenant loader must not be called when the flag is OFF'); },
  });

  assert.equal(res.status, 404);
  assert.equal((await res.json()).reason, 'not_found');
  assert.equal(dbCalls, 0, 'no DB access while dark');
  assert.equal(fetchCalls, 0, 'no Graph access while dark');
});

test('happy path: posts the reply, marks the row replied, returns 200 replied', async () => {
  const restoreToken = connectedToken();
  const { db, state } = makeFakeCommentDb({
    id: 5,
    tenant_id: 12,
    platform: 'instagram',
    external_comment_id: 'ig_c_5',
    is_replied: false,
    platform_reply_id: null,
    replied_at: null,
  });
  const calls: Array<{ url: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    return new Response(JSON.stringify({ id: 'ig_reply_9' }), { status: 200 });
  }) as typeof fetch;

  try {
    const res = await handleReplyToComment(replyRequest('Thank you!'), '5', {
      env: ENABLED,
      db,
      fetchImpl,
      tenantContextLoader: tenantLoader(12),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'replied');
    assert.equal(body.comment_id, 5);
    assert.equal(body.platform_reply_id, 'ig_reply_9');
    assert.ok(typeof body.replied_at === 'string' && body.replied_at.length > 0);
    // DB reflects the confirmed reply.
    assert.equal(state.is_replied, true);
    assert.equal(state.platform_reply_id, 'ig_reply_9');
    // Posted to the IG reply edge for the stored comment id.
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? '', /\/ig_c_5\/replies$/);
  } finally {
    restoreToken();
  }
});

test('idempotent: an already-replied comment returns already_replied with no Graph call', async () => {
  const { db } = makeFakeCommentDb({
    id: 5,
    tenant_id: 12,
    platform: 'instagram',
    external_comment_id: 'ig_c_5',
    is_replied: true,
    platform_reply_id: 'ig_reply_prev',
    replied_at: new Date().toISOString(),
  });
  let fetchCalls = 0;
  const fetchImpl = (async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); }) as typeof fetch;

  const res = await handleReplyToComment(replyRequest('hi again'), '5', {
    env: ENABLED,
    db,
    fetchImpl,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'already_replied');
  assert.equal(fetchCalls, 0, 'no Graph call for an already-replied comment');
});

test('tenant isolation: a comment owned by another tenant is invisible (404, no mutation, no Graph call)', async () => {
  const { db, state } = makeFakeCommentDb({
    id: 5,
    tenant_id: 99, // owned by tenant B
    platform: 'instagram',
    external_comment_id: 'ig_c_5',
    is_replied: false,
    platform_reply_id: null,
    replied_at: null,
  });
  let fetchCalls = 0;
  const fetchImpl = (async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); }) as typeof fetch;

  const res = await handleReplyToComment(replyRequest('hi'), '5', {
    env: ENABLED,
    db,
    fetchImpl,
    tenantContextLoader: tenantLoader(12), // acting as tenant A
  });

  assert.equal(res.status, 404);
  assert.equal((await res.json()).reason, 'not_found');
  assert.equal(fetchCalls, 0);
  assert.equal(state.is_replied, false, 'cross-tenant row is never mutated');
});

test('definitely-never-posted Graph error rolls back the claim and surfaces the error', async () => {
  const restoreToken = connectedToken();
  const { db, state } = makeFakeCommentDb({
    id: 5,
    tenant_id: 12,
    platform: 'instagram',
    external_comment_id: 'ig_c_5',
    is_replied: false,
    platform_reply_id: null,
    replied_at: null,
  });
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })) as typeof fetch;

  try {
    const res = await handleReplyToComment(replyRequest('will fail'), '5', {
      env: ENABLED,
      db,
      fetchImpl,
      tenantContextLoader: tenantLoader(12),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.equal(body.code, 'graph_api_error');
    // Claim rolled back so a retry can re-attempt.
    assert.equal(state.is_replied, false);
    assert.equal(state.platform_reply_id, null);
  } finally {
    restoreToken();
  }
});

test('outcome-unknown reply keeps the claim and returns 502 needs_manual_reconciliation', async () => {
  const restoreToken = connectedToken();
  const { db, state } = makeFakeCommentDb({
    id: 5,
    tenant_id: 12,
    platform: 'instagram',
    external_comment_id: 'ig_c_5',
    is_replied: false,
    platform_reply_id: null,
    replied_at: null,
  });
  // 2xx with no reply id -> outcome-unknown.
  const fetchImpl = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

  try {
    const res = await handleReplyToComment(replyRequest('accepted but unconfirmed'), '5', {
      env: ENABLED,
      db,
      fetchImpl,
      tenantContextLoader: tenantLoader(12),
    });

    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.status, 'needs_manual_reconciliation');
    assert.equal(body.retryable, false);
    // Claim deliberately left in place — never auto-retry an unconfirmed reply.
    assert.equal(state.is_replied, true);
  } finally {
    restoreToken();
  }
});

test('reply posts but the stamp UPDATE fails: stays replied, 200, never rolls back (no duplicate)', async () => {
  const restoreToken = connectedToken();
  // SELECT + pre-claim succeed; the success stamp throws a transient DB error
  // AFTER the reply is confirmed live on Meta. The claim must NOT be rolled back
  // (a rollback would falsely un-reply a live reply → a retry double-posts).
  const state = { is_replied: false };
  let rollbackAttempted = false;
  const db = {
    query: async (sql: string, _params: unknown[] = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (norm.startsWith('SELECT')) {
        return {
          rows: [{ id: 5, platform: 'instagram', external_comment_id: 'ig_c_5', is_replied: false }],
          rowCount: 1,
        };
      }
      if (norm.includes('SET is_replied = true')) {
        state.is_replied = true;
        return { rows: [{ id: 5 }], rowCount: 1 };
      }
      if (norm.includes('SET platform_reply_id = $1')) {
        throw new Error('connection terminated'); // transient stamp failure post-reply
      }
      if (norm.includes('SET is_replied = false')) {
        rollbackAttempted = true;
        state.is_replied = false;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${norm}`);
    },
  } as unknown as Pool;
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ id: 'ig_reply_9' }), { status: 200 })) as typeof fetch;

  try {
    const res = await handleReplyToComment(replyRequest('Thanks!'), '5', {
      env: ENABLED,
      db,
      fetchImpl,
      tenantContextLoader: tenantLoader(12),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'replied');
    assert.equal(body.platform_reply_id, 'ig_reply_9');
    assert.equal(state.is_replied, true, 'claim stays — the reply is live on the platform');
    assert.equal(rollbackAttempted, false, 'a confirmed reply is never rolled back (would double-post on retry)');
  } finally {
    restoreToken();
  }
});

test('missing reply_text returns 400 missing_reply_text before any DB load', async () => {
  let dbCalls = 0;
  const db = { query: async () => { dbCalls += 1; return { rows: [], rowCount: 0 }; } } as unknown as Pool;

  const res = await handleReplyToComment(replyRequest('   '), '5', {
    env: ENABLED,
    db,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'missing_reply_text');
  assert.equal(dbCalls, 0);
});

test('a non-Meta comment returns 422 reply_not_supported with no Graph call', async () => {
  const { db } = makeFakeCommentDb({
    id: 5,
    tenant_id: 12,
    platform: 'youtube',
    external_comment_id: 'yt_c_5',
    is_replied: false,
    platform_reply_id: null,
    replied_at: null,
  });
  let fetchCalls = 0;
  const fetchImpl = (async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); }) as typeof fetch;

  const res = await handleReplyToComment(replyRequest('hi'), '5', {
    env: ENABLED,
    db,
    fetchImpl,
    tenantContextLoader: tenantLoader(12),
  });

  assert.equal(res.status, 422);
  assert.equal((await res.json()).reason, 'reply_not_supported');
  assert.equal(fetchCalls, 0);
});
