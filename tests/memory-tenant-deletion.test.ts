import assert from 'node:assert/strict';
import test from 'node:test';

import { archiveTenantMemory } from '../backend/memory/tenant-deletion';
import { MemoryError } from '../backend/memory/errors';
import type { HonchoTransport } from '../backend/memory/honcho-client';

const SALT = 'tenant-deletion-test-salt-abcde';

function withSalt<T>(run: () => Promise<T>): Promise<T> {
  const prev = process.env.ARIES_TENANT_PSEUDONYM_SALT;
  process.env.ARIES_TENANT_PSEUDONYM_SALT = SALT;
  return Promise.resolve(run()).finally(() => {
    if (prev === undefined) delete process.env.ARIES_TENANT_PSEUDONYM_SALT;
    else process.env.ARIES_TENANT_PSEUDONYM_SALT = prev;
  });
}

function makeCtx() {
  return {
    tenantId: 'tenant-deletion-test',
    tenantSlug: 'tenant-deletion-test',
    userId: 'user-1',
    role: 'tenant_admin' as const,
  };
}

type RequestArgs = { method: string; path: string; workspaceId: string };

function allGoneTransport(): HonchoTransport {
  let deleteCalledWith: string | null = null;
  return {
    async request<T>(args: RequestArgs): Promise<T> {
      if (args.method === 'DELETE') {
        deleteCalledWith = args.workspaceId;
        return {} as T;
      }
      throw new MemoryError('workspace_not_found', `Gone: ${args.path}`, 404);
    },
    _deleteCalledWith: () => deleteCalledWith,
  } as unknown as HonchoTransport;
}

function survivorTransport(survivingPaths: string[]): HonchoTransport {
  return {
    async request<T>(args: RequestArgs): Promise<T> {
      if (args.method === 'DELETE') {
        return {} as T;
      }
      const matches = survivingPaths.some(p => args.path.includes(p));
      if (matches) {
        return { items: [{ id: 'still-here' }] } as unknown as T;
      }
      throw new MemoryError('workspace_not_found', `Gone: ${args.path}`, 404);
    },
  };
}

test('happy path: deleteWorkspace called, all surfaces return 404, result is ok', async () => {
  await withSalt(async () => {
    const transport = allGoneTransport();
    const result = await archiveTenantMemory(makeCtx(), {
      transport,
      maxPolls: 1,
      pollDelayMs: 0,
    });
    assert.equal(result.status, 'ok');
  });
});

test('workspace already gone (404 on delete) returns ok immediately', async () => {
  await withSalt(async () => {
    const transport: HonchoTransport = {
      async request<T>(args: RequestArgs): Promise<T> {
        throw new MemoryError('workspace_not_found', 'Not found', 404);
      },
    };
    const result = await archiveTenantMemory(makeCtx(), {
      transport,
      maxPolls: 1,
      pollDelayMs: 0,
    });
    assert.equal(result.status, 'ok');
  });
});

test('survivor path: one surface keeps returning data, result is incomplete with correct survivor label', async () => {
  await withSalt(async () => {
    const transport = survivorTransport(['/peers']);
    const result = await archiveTenantMemory(makeCtx(), {
      transport,
      maxPolls: 2,
      pollDelayMs: 0,
    });
    assert.equal(result.status, 'incomplete');
    if (result.status === 'incomplete') {
      assert.ok(result.survivors.includes('peers'), `expected peers in survivors, got: ${result.survivors.join(', ')}`);
    }
  });
});

test('workspace id stays inside aries-tenant-* namespace', async () => {
  await withSalt(async () => {
    const seenWorkspaceIds: string[] = [];
    const transport: HonchoTransport = {
      async request<T>(args: RequestArgs): Promise<T> {
        seenWorkspaceIds.push(args.workspaceId);
        if (args.method === 'DELETE') return {} as T;
        throw new MemoryError('workspace_not_found', 'Gone', 404);
      },
    };
    await archiveTenantMemory(makeCtx(), {
      transport,
      maxPolls: 1,
      pollDelayMs: 0,
    });
    assert.ok(seenWorkspaceIds.length > 0, 'transport should have been called');
    for (const wsid of seenWorkspaceIds) {
      assert.match(wsid, /^aries-tenant-[a-f0-9]{32}$/, `workspace id outside namespace: ${wsid}`);
    }
  });
});

test('all surfaces gone on first poll returns ok without exhausting max polls', async () => {
  await withSalt(async () => {
    let pollCount = 0;
    const transport: HonchoTransport = {
      async request<T>(args: RequestArgs): Promise<T> {
        if (args.method === 'DELETE') return {} as T;
        pollCount++;
        throw new MemoryError('workspace_not_found', 'Gone', 404);
      },
    };
    const result = await archiveTenantMemory(makeCtx(), {
      transport,
      maxPolls: 5,
      pollDelayMs: 0,
    });
    assert.equal(result.status, 'ok');
    assert.ok(pollCount <= 3, `expected at most 3 poll requests (workspace+peers+sessions), got ${pollCount}`);
  });
});
