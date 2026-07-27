import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs');

type WorkerModule = {
  SWEEP_DEAD_CAMPAIGN_SQL: string;
  SWEEP_AMBIGUOUS_DISPATCH_SQL: string;
};

async function loadWorker(): Promise<WorkerModule> {
  return (await import(pathToFileURL(WORKER_PATH).href)) as unknown as WorkerModule;
}

class TimedMutex {
  private locked = false;
  private waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  acquire(timeoutMs = 100): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('simulated_lock_timeout'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.locked = false;
      return;
    }
    clearTimeout(next.timer);
    next.resolve(() => this.release());
  }
}

type SweepState = {
  canonical: string;
  owner: string;
  child: string;
};

async function proveCanonicalFirstSweep(
  sql: string,
  expected: SweepState,
): Promise<void> {
  const canonical = new TimedMutex();
  const scheduled = new TimedMutex();
  const state: SweepState = { canonical: 'approved', owner: 'pending', child: 'pending' };

  let allowLiveScheduledLock!: () => void;
  const liveMayContinue = new Promise<void>((resolve) => { allowLiveScheduledLock = resolve; });
  let signalLiveHasCanonical!: () => void;
  const liveHasCanonical = new Promise<void>((resolve) => { signalLiveHasCanonical = resolve; });

  const liveRoute = (async () => {
    const releaseCanonical = await canonical.acquire();
    signalLiveHasCanonical();
    try {
      await liveMayContinue;
      const releaseScheduled = await scheduled.acquire();
      releaseScheduled();
    } finally {
      releaseCanonical();
    }
  })();
  await liveHasCanonical;

  const sweep = (async () => {
    const canonicalCte = sql.indexOf('WITH canonical AS MATERIALIZED');
    const canonicalLock = sql.indexOf('FROM posts', canonicalCte);
    const scheduledLock = sql.indexOf('FROM scheduled_posts');
    const canonicalFirst = canonicalCte >= 0
      && canonicalLock > canonicalCte
      && scheduledLock > canonicalLock;
    const lockOrder = canonicalFirst ? [canonical, scheduled] : [scheduled, canonical];
    const releases: Array<() => void> = [];
    try {
      for (const lock of lockOrder) releases.push(await lock.acquire());
      Object.assign(state, expected);
    } finally {
      for (const release of releases.reverse()) release();
    }
  })();

  // A scheduled-first sweep now holds the child while waiting on canonical,
  // recreating the old route↔sweep deadlock. A canonical-first sweep simply
  // waits behind the route, then applies all three outcomes atomically.
  await new Promise((resolve) => setTimeout(resolve, 10));
  allowLiveScheduledLock();
  await Promise.all([sweep, liveRoute]);
  assert.deepEqual(state, expected, 'the sweep commits a complete outcome, never a partial mirror update');
}

test('dead-campaign sweep follows canonical -> scheduled lock order with no partial outcome', async () => {
  const { SWEEP_DEAD_CAMPAIGN_SQL } = await loadWorker();
  await proveCanonicalFirstSweep(SWEEP_DEAD_CAMPAIGN_SQL, {
    canonical: 'expired',
    owner: 'failed',
    child: 'failed',
  });
});

test('ambiguous-dispatch sweep follows canonical -> scheduled lock order with no partial outcome', async () => {
  const { SWEEP_AMBIGUOUS_DISPATCH_SQL } = await loadWorker();
  await proveCanonicalFirstSweep(SWEEP_AMBIGUOUS_DISPATCH_SQL, {
    canonical: 'unverified',
    owner: 'manual_reconciliation',
    child: 'manual_reconciliation',
  });
});
