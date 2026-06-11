import assert from 'node:assert/strict';
import test from 'node:test';

// Importing the worker is side-effect free: the isDirectRun guard means main()
// (and its setInterval / signal handlers) only runs under direct invocation.
import {
  tickSafe,
  type TickPool,
  type SyncAllAccountsFn,
} from '../scripts/automations/insights-sync-worker';

// Regression for the 2026-06-09 prod wedge: tick() set `ticking = true` and
// then awaited pool.connect() with no try/finally. A connect error (Postgres
// not up yet at container start → ECONNREFUSED) escaped to a log-only .catch,
// `ticking` was never reset, and every subsequent tick skipped with
// `previous_tick_still_running` forever.

const noopSync: SyncAllAccountsFn = async () => [];

// Each tick acquires two pooled clients: one for the stranded-run sweep
// (which runs first and swallows its own failures) and one for the
// tenant-list query. The connect/release counts below reflect that.

test('a tick that fails on pool.connect() releases the overlap guard so later ticks run', async () => {
  let connectCalls = 0;
  const failingPool: TickPool = {
    connect: async () => {
      connectCalls++;
      throw Object.assign(new Error('connect ECONNREFUSED 172.18.0.11:5432'), {
        code: 'ECONNREFUSED',
      });
    },
  };

  // First tick: Postgres is not up yet. Must not throw (tickSafe swallows and
  // logs insights_sync_fatal) and must not leave the guard stuck.
  await tickSafe(failingPool, noopSync);
  assert.equal(connectCalls, 2, 'first tick attempts sweep + tenant connections');

  // Second tick: with the wedge, this skipped without touching the pool.
  await tickSafe(failingPool, noopSync);
  assert.equal(connectCalls, 4, 'second tick must retry the connections, not skip');

  // Postgres comes up: the next tick proceeds all the way to the tenant query.
  let tenantQueries = 0;
  const healthyPool: TickPool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (/SELECT DISTINCT tenant_id/.test(sql)) tenantQueries++;
        return { rows: [] };
      },
      release: () => {},
    }),
  };
  await tickSafe(healthyPool, noopSync);
  assert.equal(tenantQueries, 1, 'a recovered tick reaches the tenant query');
});

test('a tick that fails on the tenant query releases the client and the overlap guard', async () => {
  let connectCalls = 0;
  let releaseCalls = 0;
  const queryFailPool: TickPool = {
    connect: async () => {
      connectCalls++;
      return {
        query: async () => {
          throw new Error('relation "insights_accounts" does not exist');
        },
        release: () => {
          releaseCalls++;
        },
      };
    },
  };

  await tickSafe(queryFailPool, noopSync);
  assert.equal(releaseCalls, 2, 'both pooled clients are released even when their queries throw');

  await tickSafe(queryFailPool, noopSync);
  assert.equal(connectCalls, 4, 'a query failure must not wedge the guard either');
  assert.equal(releaseCalls, 4, 'every failed tick releases its clients');
});

test('a tenant sync failure is isolated: later tenants still sync and the guard releases', async () => {
  const poolWithTenants: TickPool = {
    connect: async () => ({
      query: async () => ({ rows: [{ tenant_id: 1 }, { tenant_id: 2 }] }),
      release: () => {},
    }),
  };

  const syncedTenants: number[] = [];
  const flakySync: SyncAllAccountsFn = async (tenantId) => {
    syncedTenants.push(tenantId);
    if (tenantId === 1) {
      throw new Error('Meta Graph API 500');
    }
    return [
      {
        syncRunId: 10 + tenantId,
        accountId: tenantId,
        platform: 'instagram',
        status: 'ok',
        postsSeen: 3,
        commentsSeen: 1,
        apiUnitsUsed: 4,
      },
    ];
  };

  await tickSafe(poolWithTenants, flakySync);
  assert.deepEqual(
    syncedTenants,
    [1, 2],
    'tenant 1 throwing must not starve tenant 2 in the same tick',
  );

  // The guard must be released so the next interval retries the failed tenant.
  await tickSafe(poolWithTenants, flakySync);
  assert.deepEqual(
    syncedTenants,
    [1, 2, 1, 2],
    'the next tick runs (guard released) and fans out to every tenant again',
  );
});

test('the overlap guard still skips ticks while one is genuinely in flight', async () => {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  let connectCalls = 0;
  const slowPool: TickPool = {
    connect: async () => {
      connectCalls++;
      await gate;
      return {
        query: async () => ({ rows: [] }),
        release: () => {},
      };
    },
  };

  const firstTick = tickSafe(slowPool, noopSync);
  try {
    // Overlapping tick while the first is still on its initial (sweep)
    // connection: must skip.
    await tickSafe(slowPool, noopSync);
    assert.equal(connectCalls, 1, 'an overlapping tick is skipped, not run concurrently');
  } finally {
    // Always release the in-flight tick so a failed assertion above cannot
    // leave the module-level guard held for any test added after this one.
    releaseGate();
    await firstTick;
  }

  // After the in-flight tick completes (sweep + tenant connects), the guard
  // is released again and the next tick connects twice more.
  await tickSafe(slowPool, noopSync);
  assert.equal(connectCalls, 4, 'the guard is released once the in-flight tick finishes');
});
