import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryError } from '../backend/memory/errors';
import { TenantMemoryClient } from '../backend/memory/honcho-client';
import type { HonchoTransport } from '../backend/memory/honcho-client';
import type { TenantContext } from '../lib/tenant-context';

const SALT = 'memory-honcho-client-test-salt';

function withSalt<T>(run: () => Promise<T> | T): Promise<T> {
  const prev = process.env.ARIES_TENANT_PSEUDONYM_SALT;
  process.env.ARIES_TENANT_PSEUDONYM_SALT = SALT;
  return Promise.resolve(run()).finally(() => {
    if (prev === undefined) delete process.env.ARIES_TENANT_PSEUDONYM_SALT;
    else process.env.ARIES_TENANT_PSEUDONYM_SALT = prev;
  });
}

function makeCtx(tenantId: string): Pick<TenantContext, 'tenantId' | 'tenantSlug' | 'userId' | 'role'> {
  return { tenantId, tenantSlug: `slug-${tenantId}`, userId: 'user-1', role: 'tenant_admin' };
}

type Captured = { method: string; path: string; workspaceId: string; body?: unknown };

function recordingTransport(): { transport: HonchoTransport; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    transport: {
      async request<T>(args: { method: string; path: string; workspaceId: string; body?: unknown }): Promise<T> {
        calls.push({ method: args.method, path: args.path, workspaceId: args.workspaceId, body: args.body });
        // Honcho v3 POST /sessions/{sid}/messages returns an array of Message;
        // return an array so the client's response-shape parsing is exercised
        // in the assertion below.
        return [{ id: `msg-${calls.length}` }] as unknown as T;
      },
    },
  };
}

test('TenantMemoryClient computes a stable tenant-scoped workspace id', async () => {
  await withSalt(() => {
    const { transport } = recordingTransport();
    const client = new TenantMemoryClient(transport);
    const wsid = client.workspaceId(makeCtx('t-1'));
    assert.match(wsid, /^aries-tenant-[a-f0-9]{32}$/);
    const wsid2 = client.workspaceId(makeCtx('t-1'));
    assert.equal(wsid, wsid2);
  });
});

test('TenantMemoryClient refuses to operate without TenantContext', async () => {
  await withSalt(() => {
    const { transport } = recordingTransport();
    const client = new TenantMemoryClient(transport);
    assert.throws(
      () => client.workspaceId(null as unknown as ReturnType<typeof makeCtx>),
      (err: unknown) => err instanceof MemoryError && err.code === 'tenant_context_required',
    );
  });
});

test('TenantMemoryClient routes appendApprovedMessage into the tenant workspace', async () => {
  await withSalt(async () => {
    const { transport, calls } = recordingTransport();
    const client = new TenantMemoryClient(transport);
    const ctx = makeCtx('t-7');
    const expectedWsid = client.workspaceId(ctx);

    await client.appendApprovedMessage({
      ctx,
      peer: { kind: 'brand' },
      session: { kind: 'curated', jobId: 'job-abc' },
      message: {
        kind: 'fact',
        claim: 'Brand was founded in 2018.',
        sources: [{ url: 'https://acme.example/about', fetched_at: '2026-05-08T00:00:00Z', trust: 'first_party' }],
        confidence: 0.9,
        approved_by: 'system',
        approved_at: '2026-05-08T00:00:00Z',
        supersedes: null,
        research_job_id: 'job-abc',
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].workspaceId, expectedWsid);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].path, /\/v3\/workspaces\/aries-tenant-[a-f0-9]{32}\/sessions\/session-curated-job-abc\/messages$/);

    // Regression: Honcho v3 expects MessageBatchCreate ({ messages: [...] }),
    // not a flat single-object body. A flat body returns 422 with
    // "missing body.messages" — silently swallowed by the write-event wrapper,
    // so every Phase 1/2/3 mirror write was no-op until this shape was fixed.
    const body = calls[0].body as { messages?: Array<{ peer_id?: string; content?: string; metadata?: Record<string, unknown> }> };
    assert.ok(Array.isArray(body?.messages), 'body must wrap messages in an array (MessageBatchCreate)');
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].peer_id, 'peer-brand');
    assert.match(body.messages[0].content ?? '', /strategy_stage_approved|"kind":"fact"|"claim":"Brand was founded/);
    assert.equal(body.messages[0].metadata?.kind, 'fact');
  });
});

test('TenantMemoryClient.listApprovedMessages uses Honcho v3 POST /messages/list with peer_id filter', async () => {
  await withSalt(async () => {
    const { transport, calls } = recordingTransport();
    const client = new TenantMemoryClient(transport);
    const ctx = makeCtx('t-list-1');

    await client.listApprovedMessages({
      ctx,
      peer: { kind: 'brand' },
      session: { kind: 'curated', jobId: 'job-xyz' },
      includeSuperseded: false,
    });

    assert.equal(calls.length, 1);
    // Regression: must be POST to /messages/list, not GET on /messages
    // (Honcho v3 has no GET /messages endpoint; GET returned 405 silently).
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].path, /\/v3\/workspaces\/aries-tenant-[a-f0-9]{32}\/sessions\/session-curated-job-xyz\/messages\/list$/);
    const body = calls[0].body as { filters?: { peer_id?: string } };
    assert.equal(body?.filters?.peer_id, 'peer-brand');
  });
});

test('TenantMemoryClient.listApprovedMessages without a session returns [] (peer-scoped read TODO on v3)', async () => {
  await withSalt(async () => {
    const { transport, calls } = recordingTransport();
    const client = new TenantMemoryClient(transport);
    const ctx = makeCtx('t-list-2');

    const messages = await client.listApprovedMessages({
      ctx,
      peer: { kind: 'brand' },
      // session intentionally omitted
      includeSuperseded: false,
    });

    assert.deepEqual(messages, []);
    assert.equal(calls.length, 0, 'no transport call when session is missing (no v3 peer-scoped messages list)');
  });
});

test('Per-tenant workspace ids do not collide', async () => {
  await withSalt(() => {
    const { transport } = recordingTransport();
    const client = new TenantMemoryClient(transport);
    assert.notEqual(client.workspaceId(makeCtx('t-a')), client.workspaceId(makeCtx('t-b')));
  });
});

// ---------------------------------------------------------------------------
// ITEM A — dialectic read + prose observation write
// ---------------------------------------------------------------------------

/** Transport that answers /chat with a canned DialecticResponse. */
function dialecticTransport(content: string | null): { transport: HonchoTransport; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    transport: {
      async request<T>(args: { method: string; path: string; workspaceId: string; body?: unknown }): Promise<T> {
        calls.push({ method: args.method, path: args.path, workspaceId: args.workspaceId, body: args.body });
        return { content } as unknown as T;
      },
    },
  };
}

test('dialecticQuery POSTs the v3 chat contract and returns content', async () => {
  await withSalt(async () => {
    const { transport, calls } = dialecticTransport('Audience skews 25-40, reels outperform statics.');
    const client = new TenantMemoryClient(transport);
    const ctx = makeCtx('t-dq');
    const wsid = client.workspaceId(ctx);

    const answer = await client.dialecticQuery({
      ctx,
      peer: { kind: 'brand' },
      query: 'What do we know about this brand?',
    });

    assert.equal(answer, 'Audience skews 25-40, reels outperform statics.');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, `/v3/workspaces/${wsid}/peers/peer-brand/chat`);
    // Honcho v3 DialecticOptions: { query, stream, reasoning_level }.
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.query, 'What do we know about this brand?');
    assert.equal(body.stream, false);
    assert.equal(body.reasoning_level, 'low');
  });
});

test('dialecticQuery returns null for a null/blank representation answer', async () => {
  await withSalt(async () => {
    const nullish = dialecticTransport(null);
    const client = new TenantMemoryClient(nullish.transport);
    assert.equal(
      await client.dialecticQuery({ ctx: makeCtx('t-dq2'), peer: { kind: 'policy' }, query: 'anything?' }),
      null,
    );

    const blank = dialecticTransport('   ');
    const client2 = new TenantMemoryClient(blank.transport);
    assert.equal(
      await client2.dialecticQuery({ ctx: makeCtx('t-dq3'), peer: { kind: 'policy' }, query: 'anything?' }),
      null,
    );
  });
});

test('dialecticQuery refuses an empty query rather than burning a call', async () => {
  await withSalt(async () => {
    const { transport, calls } = dialecticTransport('x');
    const client = new TenantMemoryClient(transport);
    await assert.rejects(
      () => client.dialecticQuery({ ctx: makeCtx('t-dq4'), peer: { kind: 'brand' }, query: '   ' }),
      (err: unknown) => err instanceof MemoryError && err.code === 'invalid_request',
    );
    assert.equal(calls.length, 0);
  });
});

test('appendObservation posts batched prose to session-performance-<jobId> on peer-brand', async () => {
  await withSalt(async () => {
    const { transport, calls } = recordingTransport();
    const client = new TenantMemoryClient(transport);
    const ctx = makeCtx('t-obs');
    const wsid = client.workspaceId(ctx);

    const { messageId } = await client.appendObservation({
      ctx,
      peer: { kind: 'brand' },
      session: { kind: 'performance', jobId: 'job-42' },
      content: 'Post performance observation (instagram reel, published 2026-05-25): reach 1200.',
      metadata: { kind: 'performance_observation' },
    });

    assert.equal(messageId, 'msg-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, `/v3/workspaces/${wsid}/sessions/session-performance-job-42/messages`);
    const body = calls[0].body as { messages: Array<Record<string, unknown>> };
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].peer_id, 'peer-brand');
    // Prose, not a JSON blob — the deriver reads content.
    assert.match(String(body.messages[0].content), /^Post performance observation/);
    assert.deepEqual(body.messages[0].metadata, { kind: 'performance_observation' });
  });
});

test('appendObservation rejects a non-slug jobId before touching the transport', async () => {
  await withSalt(async () => {
    const { transport, calls } = recordingTransport();
    const client = new TenantMemoryClient(transport);
    await assert.rejects(
      () =>
        client.appendObservation({
          ctx: makeCtx('t-obs2'),
          peer: { kind: 'brand' },
          session: { kind: 'performance', jobId: '../../escape' },
          content: 'x',
        }),
      (err: unknown) => err instanceof MemoryError && err.code === 'invalid_request',
    );
    assert.equal(calls.length, 0);
  });
});
