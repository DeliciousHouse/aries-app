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
        return { id: `msg-${calls.length}`, items: [] } as unknown as T;
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
    assert.match(calls[0].path, /\/v3\/workspaces\/aries-tenant-[a-f0-9]{32}\/sessions\/session-curated-job-abc\/messages$/);
  });
});

test('Per-tenant workspace ids do not collide', async () => {
  await withSalt(() => {
    const { transport } = recordingTransport();
    const client = new TenantMemoryClient(transport);
    assert.notEqual(client.workspaceId(makeCtx('t-a')), client.workspaceId(makeCtx('t-b')));
  });
});
