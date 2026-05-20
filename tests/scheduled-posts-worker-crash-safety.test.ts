import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type WorkerModule = {
  tick: (pool: FakePool) => Promise<{ processed: number; dispatched: number; failed: number; skipped: number }>;
};

async function loadWorker(): Promise<WorkerModule> {
  return (await import(
    path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs')
  )) as unknown as WorkerModule;
}

// --- In-memory pg fake -----------------------------------------------------
// Reproduces just enough Postgres semantics for the scheduled-posts worker:
// the scheduled_posts row, its scheduled_post_dispatches children, and the
// claim / in_flight / rollup queries. A transaction's writes are buffered and
// only applied on COMMIT, so a "crash" (an exception thrown after COMMIT but
// before the next COMMIT) leaves exactly the committed state behind.

type SchedRow = {
  id: number;
  post_id: number;
  tenant_id: number;
  target_platforms: string[];
  caption: string;
  platform_post_id: string | null;
  scheduled_for: string;
  dispatch_status: string;
  dispatched_at: string | null;
  error_at: string | null;
  error_message: string | null;
  updated_at: string;
};
type ChildRow = {
  scheduled_post_id: number;
  platform: string;
  status: string;
  dispatched_at: string | null;
  error_at: string | null;
  error_message: string | null;
};

class FakeDb {
  scheduled: SchedRow[] = [];
  children: ChildRow[] = [];
}

class FakeClient {
  private tx: { scheduled: SchedRow[]; children: ChildRow[] } | null = null;
  constructor(private db: FakeDb) {}

  private active() {
    return this.tx ?? { scheduled: this.db.scheduled, children: this.db.children };
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const s = sql.trim();
    if (s === 'BEGIN') {
      this.tx = {
        scheduled: this.db.scheduled.map((r) => ({ ...r })),
        children: this.db.children.map((r) => ({ ...r })),
      };
      return { rows: [], rowCount: 0 };
    }
    if (s === 'COMMIT') {
      if (this.tx) {
        this.db.scheduled = this.tx.scheduled;
        this.db.children = this.tx.children;
      }
      this.tx = null;
      return { rows: [], rowCount: 0 };
    }
    if (s === 'ROLLBACK') {
      this.tx = null;
      return { rows: [], rowCount: 0 };
    }

    const store = this.active();

    if (s.startsWith('SELECT id FROM scheduled_posts')) {
      const cutoff = String(params[1]);
      const rows = store.scheduled
        .filter(
          (r) =>
            r.dispatch_status === 'pending' ||
            (r.dispatch_status === 'in_flight' && r.updated_at < cutoff),
        )
        .map((r) => ({ id: r.id }));
      return { rows, rowCount: rows.length };
    }

    if (s.includes('FROM scheduled_posts sp')) {
      // claim row
      const id = Number(params[0]);
      const cutoff = String(params[1]);
      const row = store.scheduled.find(
        (r) =>
          r.id === id &&
          (r.dispatch_status === 'pending' ||
            (r.dispatch_status === 'in_flight' && r.updated_at < cutoff)),
      );
      if (!row) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: row.id,
            post_id: row.post_id,
            tenant_id: row.tenant_id,
            target_platforms: row.target_platforms,
            caption: row.caption,
            platform_post_id: row.platform_post_id,
          },
        ],
        rowCount: 1,
      };
    }

    if (s.startsWith('INSERT INTO scheduled_post_dispatches')) {
      const [spId, platform] = params as [number, string];
      const existing = store.children.find(
        (c) => c.scheduled_post_id === spId && c.platform === platform,
      );
      if (!existing) {
        store.children.push({
          scheduled_post_id: spId,
          platform,
          status: 'in_flight',
          dispatched_at: null,
          error_at: null,
          error_message: null,
        });
      } else if (existing.status === 'pending' || existing.status === 'in_flight') {
        existing.status = 'in_flight';
      }
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('UPDATE scheduled_post_dispatches')) {
      const [spId, platform, status, errMsg] = params as [number, string, string, string | null];
      const child = store.children.find(
        (c) => c.scheduled_post_id === spId && c.platform === platform,
      );
      if (child) {
        child.status = status;
        if (status === 'dispatched') child.dispatched_at = new Date().toISOString();
        if (status === 'failed') {
          child.error_at = new Date().toISOString();
          child.error_message = errMsg;
        }
      }
      return { rows: [], rowCount: child ? 1 : 0 };
    }

    if (s.startsWith('SELECT platform FROM scheduled_post_dispatches')) {
      const spId = Number(params[0]);
      const rows = store.children
        .filter((c) => c.scheduled_post_id === spId && c.status === 'dispatched')
        .map((c) => ({ platform: c.platform }));
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('SELECT status, error_message FROM scheduled_post_dispatches')) {
      const spId = Number(params[0]);
      const rows = store.children
        .filter((c) => c.scheduled_post_id === spId)
        .map((c) => ({ status: c.status, error_message: c.error_message }));
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('UPDATE scheduled_posts')) {
      // markInFlight uses ($1) id; syncParentRollup uses ($1 id, $2 status, $3 err)
      const id = Number(params[0]);
      const row = store.scheduled.find((r) => r.id === id);
      if (row) {
        if (s.includes("dispatch_status = 'in_flight'")) {
          row.dispatch_status = 'in_flight';
          row.updated_at = new Date().toISOString();
        } else {
          const status = String(params[1]);
          row.dispatch_status = status;
          if (status === 'dispatched') row.dispatched_at = new Date().toISOString();
          if (status === 'failed') {
            row.error_at = new Date().toISOString();
            row.error_message = (params[2] as string | null) ?? null;
          }
        }
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (s.startsWith('UPDATE posts')) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`FakeClient: unhandled SQL: ${s.slice(0, 80)}`);
  }

  release() {
    /* no-op */
  }
}

type FakePool = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
  connect: () => Promise<FakeClient>;
};

function makePool(db: FakeDb): FakePool {
  return {
    query: (sql: string, params: unknown[] = []) => new FakeClient(db).query(sql, params),
    connect: async () => new FakeClient(db),
  };
}

function seedDueRow(db: FakeDb): void {
  db.scheduled.push({
    id: 1,
    post_id: 100,
    tenant_id: 7,
    target_platforms: ['facebook', 'instagram'],
    caption: 'hello world',
    platform_post_id: null,
    scheduled_for: new Date(Date.now() - 60_000).toISOString(),
    dispatch_status: 'pending',
    dispatched_at: null,
    error_at: null,
    error_message: null,
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  });
}

test('worker commits in_flight before publish; a crash mid-publish leaves a reclaimable row', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const realFetch = globalThis.fetch;
  try {
    // Simulate a crash during the network publish: fetch throws every time.
    // dispatchWithRetry catches this into a transportError, so the per-platform
    // outcomes all stay 'pending' — i.e. nothing is terminally marked.
    let observedDuringPublish: string | undefined;
    globalThis.fetch = (async () => {
      // At this point the in_flight transaction is already committed.
      observedDuringPublish = db.scheduled[0].dispatch_status;
      throw new Error('simulated worker crash during publish');
    }) as typeof fetch;

    await tick(makePool(db));

    assert.equal(
      observedDuringPublish,
      'in_flight',
      'the parent row must be committed as in_flight BEFORE the publish call runs',
    );

    // After a failed publish, the row must NOT be falsely 'dispatched'. It is
    // a non-terminal state the next pass can re-claim.
    const row = db.scheduled[0];
    assert.notEqual(row.dispatch_status, 'dispatched', 'a crashed publish must never leave a false dispatched row');
    assert.ok(
      row.dispatch_status === 'in_flight' || row.dispatch_status === 'pending',
      `row must stay non-terminal after a crashed publish, got '${row.dispatch_status}'`,
    );
    // Children likewise stayed non-terminal.
    assert.ok(
      db.children.every((c) => c.status === 'in_flight' || c.status === 'pending'),
      'child rows must stay non-terminal after a crashed publish',
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  // --- A later worker pass re-claims the stuck row and completes it ---------
  // Backdate updated_at so the row is past the stale-in_flight reclaim window.
  db.scheduled[0].dispatch_status = 'in_flight';
  db.scheduled[0].updated_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (const c of db.children) c.status = 'in_flight';

  const realFetch2 = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: 'ok',
          results: [
            { provider: 'facebook', ok: true },
            { provider: 'instagram', ok: true },
          ],
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const report = await tick(makePool(db));
    assert.equal(report.dispatched, 1, 'the re-claim pass dispatches the stuck row');
    assert.equal(db.scheduled[0].dispatch_status, 'dispatched', 'row reaches terminal dispatched after a successful re-claim');
    assert.ok(
      db.children.every((c) => c.status === 'dispatched'),
      'all child rows are dispatched after the successful re-claim',
    );
  } finally {
    globalThis.fetch = realFetch2;
  }
});

test('a fresh in_flight row (within the reclaim window) is NOT stolen by another pass', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  // A row currently in flight, claimed seconds ago — a live publish in progress.
  db.scheduled[0].dispatch_status = 'in_flight';
  db.scheduled[0].updated_at = new Date().toISOString();

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  let fetchCalled = false;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 202 });
    }) as typeof fetch;
    const report = await tick(makePool(db));
    assert.equal(report.processed, 0, 'a fresh in_flight row is not picked up by another pass');
    assert.equal(fetchCalled, false, 'no publish is attempted for a row already in flight');
  } finally {
    globalThis.fetch = realFetch;
  }
});
