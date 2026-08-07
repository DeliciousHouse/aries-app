import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { upsertScheduledPost } from '../backend/social-content/scheduled-posts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type WorkerModule = {
  tick: (pool: FakePool) => Promise<{
    processed: number;
    dispatched: number;
    failed: number;
    deadLettered: number;
    skipped: number;
    manualReconciliation: number;
  }>;
  parseShutdownTimeoutMs: (raw: string | undefined) => number;
  resolveDispatchFetchTimeoutMs: (mediaType: string | undefined) => number;
  createScheduledPostsWorkerRuntime: (pool: FakePool) => {
    runTick: () => Promise<{ processed: number; dispatched: number; failed: number; skipped: number }>;
    shutdown: (timeoutMs?: number) => Promise<boolean>;
  };
};

async function loadWorker(): Promise<WorkerModule> {
  return (await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs')).href
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
  media_type?: string;
  platform_post_id: string | null;
  scheduled_for: string;
  dispatch_status: string;
  dispatched_at: string | null;
  error_at: string | null;
  error_message: string | null;
  dispatch_attempt_token: string | null;
  dispatch_claimed_at: string | null;
  dispatch_started_at: string | null;
  updated_at: string;
  next_attempt_backoff_minutes?: number | null;
  failure_class?: string | null;
  dead_lettered_at?: string | null;
};
type ChildRow = {
  scheduled_post_id: number;
  platform: string;
  status: string;
  platform_post_id: string | null;
  dispatched_at: string | null;
  error_at: string | null;
  error_message: string | null;
  failure_class?: string | null;
  attempts?: number;
  dead_lettered_at?: string | null;
};
type PostRow = {
  id: number;
  tenant_id: number;
  published_status: string;
  platform_post_id: string | null;
  published_at: string | null;
};

class FakeDb {
  scheduled: SchedRow[] = [];
  children: ChildRow[] = [];
  posts: PostRow[] = [];
  beforeOutcomeWrite: (() => Promise<void>) | null = null;
  beforeClaimCommit: (() => Promise<void>) | null = null;
  private updatedAtSequence = Date.now();

  nextUpdatedAt(): string {
    this.updatedAtSequence += 1;
    return new Date(this.updatedAtSequence).toISOString();
  }
}

class FakeClient {
  private tx: { scheduled: SchedRow[]; children: ChildRow[]; posts: PostRow[] } | null = null;
  constructor(private db: FakeDb) {}

  private active() {
    return this.tx ?? { scheduled: this.db.scheduled, children: this.db.children, posts: this.db.posts };
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const s = sql.trim();
    if (s === 'BEGIN') {
      this.tx = {
        scheduled: this.db.scheduled.map((r) => ({ ...r })),
        children: this.db.children.map((r) => ({ ...r })),
        posts: this.db.posts.map((r) => ({ ...r })),
      };
      return { rows: [], rowCount: 0 };
    }
    if (s === 'COMMIT') {
      if (this.tx) {
        const createsPreProviderClaim = this.tx.scheduled.some((candidate) => {
          const live = this.db.scheduled.find((row) => row.id === candidate.id);
          return candidate.dispatch_status === 'in_flight'
            && candidate.dispatch_started_at === null
            && live?.dispatch_status !== 'in_flight';
        });
        if (createsPreProviderClaim && this.db.beforeClaimCommit) {
          await this.db.beforeClaimCommit();
        }
        this.db.scheduled = this.tx.scheduled;
        this.db.children = this.tx.children;
        this.db.posts = this.tx.posts;
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
            (r.dispatch_status === 'in_flight'
              && r.dispatch_started_at === null
              && (r.dispatch_claimed_at ?? '') < cutoff),
        )
        .map((r) => ({ id: r.id }));
      return { rows, rowCount: rows.length };
    }

    if (s.includes('FROM scheduled_posts sp') || s.includes('locked_owner AS MATERIALIZED')) {
      // claim row
      const id = Number(params[0]);
      const cutoff = String(params[1]);
      const row = store.scheduled.find(
        (r) =>
          r.id === id &&
          (r.dispatch_status === 'pending' ||
            (r.dispatch_status === 'in_flight'
              && r.dispatch_started_at === null
              && (r.dispatch_claimed_at ?? '') < cutoff)),
      );
      if (!row) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: row.id,
            post_id: row.post_id,
            canonical_post_id: store.posts.find(
              (post) => post.id === row.post_id && post.tenant_id === row.tenant_id,
            )?.id ?? null,
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
      // Multi-row seed: params are [scheduledPostId, ...platforms].
      const [spId, ...platforms] = params as [number, ...string[]];
      for (const platform of platforms) {
        const existing = store.children.find(
          (c) => c.scheduled_post_id === spId && c.platform === platform,
        );
        if (!existing) {
          store.children.push({
            scheduled_post_id: spId,
            platform,
            status: 'in_flight',
            platform_post_id: null,
            dispatched_at: null,
            error_at: null,
            error_message: null,
            failure_class: null,
            attempts: 0,
            dead_lettered_at: null,
          });
        } else if (existing.status === 'pending' || existing.status === 'in_flight') {
          existing.status = 'in_flight';
        }
      }
      return { rows: [], rowCount: platforms.length };
    }

    if (s.startsWith('UPDATE scheduled_post_dispatches')) {
      if (this.db.beforeOutcomeWrite) await this.db.beforeOutcomeWrite();
      const [spId, platform, status, errMsg, platformPostId, attemptToken, failureClass] = params as [
        number,
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
      ];
      const child = store.children.find(
        (c) => c.scheduled_post_id === spId && c.platform === platform,
      );
      const owner = store.scheduled.find((r) => r.id === spId);
      const ownsAttempt = owner?.dispatch_status === 'in_flight'
        && owner.dispatch_attempt_token === attemptToken;
      if (child && ownsAttempt) {
        child.status = status;
        child.attempts = (child.attempts ?? 0) + 1;
        child.failure_class = failureClass;
        if (!child.platform_post_id && platformPostId) child.platform_post_id = platformPostId;
        if (status === 'dispatched') child.dispatched_at = new Date().toISOString();
        if (status === 'failed' || status === 'dead_letter' || status === 'manual_reconciliation') {
          child.error_at = new Date().toISOString();
          child.error_message = errMsg;
        }
        if (status === 'dead_letter') child.dead_lettered_at = new Date().toISOString();
      }
      return { rows: [], rowCount: child && ownsAttempt ? 1 : 0 };
    }

    if (s.startsWith('SELECT platform, status, attempts FROM scheduled_post_dispatches')) {
      const spId = Number(params[0]);
      const rows = store.children
        .filter((c) => c.scheduled_post_id === spId)
        .map((c) => ({ platform: c.platform, status: c.status, attempts: c.attempts ?? 0 }));
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('SELECT platform, platform_post_id')) {
      const spId = Number(params[0]);
      const rows = store.children
        .filter((c) => c.scheduled_post_id === spId && c.status === 'dispatched')
        .map((c) => ({ platform: c.platform, platform_post_id: c.platform_post_id }));
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('SELECT 1') && s.includes('FROM scheduled_posts')) {
      const [spId, attemptToken] = params as [number, string];
      const owner = store.scheduled.find(
        (r) =>
          r.id === spId
          && r.dispatch_status === 'in_flight'
          && r.dispatch_attempt_token === attemptToken,
      );
      return {
        rows: owner ? [{ '?column?': 1 }] : [],
        rowCount: owner ? 1 : 0,
      };
    }

    if (s.startsWith('SELECT status, error_message, failure_class FROM scheduled_post_dispatches')) {
      const spId = Number(params[0]);
      const rows = store.children
        .filter((c) => c.scheduled_post_id === spId)
        .map((c) => ({
          status: c.status,
          error_message: c.error_message,
          failure_class: c.failure_class ?? null,
        }));
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('UPDATE scheduled_posts')) {
      // markInFlight uses ($1 id, $2 token); syncParentRollup uses
      // ($1 id, $2 status, $3 err, $4 token);
      // setNextAttemptAt uses ($1 id, $2 backoff minutes).
      const id = Number(params[0]);
      const row = store.scheduled.find((r) => r.id === id);
      if (row) {
        if (s.includes('next_attempt_at = now()')) {
          row.next_attempt_backoff_minutes = Number(params[1]);
        } else if (s.includes("SET dispatch_status = 'in_flight'")) {
          row.dispatch_status = 'in_flight';
          row.dispatch_attempt_token = String(params[1]);
          row.dispatch_claimed_at = this.db.nextUpdatedAt();
          row.dispatch_started_at = null;
          row.updated_at = row.dispatch_claimed_at;
          return {
            rows: [{ attempt_token: row.dispatch_attempt_token }],
            rowCount: 1,
          };
        } else {
          const attemptToken = params[3] as string | undefined;
          if (
            attemptToken !== undefined
            && (row.dispatch_status !== 'in_flight' || row.dispatch_attempt_token !== attemptToken)
          ) {
            return { rows: [], rowCount: 0 };
          }
          const status = String(params[1]);
          row.dispatch_status = status;
          if (status === 'dispatched') row.dispatched_at = new Date().toISOString();
          if (status === 'failed' || status === 'dead_letter' || status === 'manual_reconciliation') {
            row.error_at = new Date().toISOString();
            row.error_message = (params[2] as string | null) ?? null;
            row.failure_class = (params[4] as string | null | undefined) ?? null;
          }
          if (status === 'dead_letter') row.dead_lettered_at = new Date().toISOString();
        }
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (s.startsWith('SELECT id') && s.includes('FROM posts') && s.includes('FOR UPDATE')) {
      const [postId, tenantId] = params.map(Number);
      const post = store.posts.find(
        (candidate) => candidate.id === postId && candidate.tenant_id === tenantId,
      );
      return { rows: post ? [{ id: post.id }] : [], rowCount: post ? 1 : 0 };
    }

    if (s.startsWith('UPDATE posts')) {
      const [scheduledPostId, postId, tenantId, attemptToken, terminalStatus] = params as [
        number,
        number,
        number,
        string,
        string | undefined,
      ];
      const owner = store.scheduled.find(
        (row) => row.id === scheduledPostId
          && row.dispatch_status === 'in_flight'
          && row.dispatch_attempt_token === attemptToken,
      );
      const post = store.posts.find(
        (candidate) => candidate.id === postId && candidate.tenant_id === tenantId,
      );
      const firstSuccess = store.children.find(
        (child) => child.scheduled_post_id === scheduledPostId
          && child.status === 'dispatched'
          && child.platform_post_id !== null,
      );
      if (owner && post && terminalStatus) {
        if (!firstSuccess && post.published_status !== 'published') {
          post.published_status = terminalStatus === 'manual_reconciliation' ? 'unverified' : 'failed';
        }
        return { rows: [{ id: post.id }], rowCount: 1 };
      }
      if (!owner || !post || !firstSuccess) return { rows: [], rowCount: 0 };
      post.published_status = 'published';
      post.platform_post_id ??= firstSuccess.platform_post_id;
      post.published_at ??= new Date().toISOString();
      return { rows: [{ id: post.id }], rowCount: 1 };
    }

    if (s.startsWith('WITH orphaned_owner AS')) {
      const id = Number(params[0]);
      const row = store.scheduled.find((candidate) => candidate.id === id);
      if (!row) return { rows: [{ quarantined: 0 }], rowCount: 1 };
      row.dispatch_status = 'failed';
      row.error_at = new Date().toISOString();
      row.error_message = 'orphaned_schedule: canonical post missing; provider was not called';
      for (const child of store.children) {
        if (child.scheduled_post_id === id && (child.status === 'pending' || child.status === 'in_flight')) {
          child.status = 'failed';
          child.error_at = new Date().toISOString();
          child.error_message = row.error_message;
        }
      }
      return { rows: [{ quarantined: 1 }], rowCount: 1 };
    }

    if (s.startsWith('WITH released_owner AS') || s.includes('released_owner AS')) {
      const [spId, attemptToken] = params as [number, string];
      const owner = store.scheduled.find(
        (row) => row.id === spId
          && row.dispatch_status === 'in_flight'
          && row.dispatch_started_at === null
          && row.dispatch_attempt_token === attemptToken,
      );
      if (!owner) return { rows: [{ released: 0 }], rowCount: 1 };
      owner.dispatch_status = 'pending';
      owner.dispatch_attempt_token = null;
      owner.dispatch_claimed_at = null;
      for (const child of store.children) {
        if (child.scheduled_post_id === spId && child.status === 'in_flight') {
          child.status = 'pending';
        }
      }
      return { rows: [{ released: 1 }], rowCount: 1 };
    }

    if (s.startsWith('WITH canonical AS MATERIALIZED') && s.includes('owner.dispatch_claimed_at')) {
      const cutoff = String(params[1]);
      const derivesDurableTruth = s.includes('all_requested_dispatched');
      let swept = 0;
      let manualReconciliation = 0;
      for (const row of store.scheduled) {
        if (
          row.dispatch_status !== 'in_flight'
          || row.dispatch_started_at === null
          || (row.dispatch_claimed_at ?? '') >= cutoff
        ) continue;
        row.dispatch_status = 'manual_reconciliation';
        row.error_at = new Date().toISOString();
        row.error_message = 'publish_outcome_unknown: manual reconciliation required; no auto-retry';
        for (const child of store.children) {
          if (
            child.scheduled_post_id === row.id
            && (child.status === 'pending' || child.status === 'in_flight')
          ) {
            child.status = 'manual_reconciliation';
            child.error_at = new Date().toISOString();
            child.error_message = row.error_message;
          }
        }
        const post = store.posts.find(
          (candidate) => candidate.id === row.post_id && candidate.tenant_id === row.tenant_id,
        );
        if (derivesDurableTruth) {
          const dispatchedChildren = store.children.filter(
            (child) => child.scheduled_post_id === row.id && child.status === 'dispatched',
          );
          if (post && dispatchedChildren.length > 0) {
            post.published_status = 'published';
            post.platform_post_id ??= dispatchedChildren.find(
              (child) => child.platform_post_id !== null,
            )?.platform_post_id ?? null;
            post.published_at ??= new Date().toISOString();
          } else if (post && post.published_status !== 'published') {
            post.published_status = 'unverified';
          }
          const allRequestedDispatched = row.target_platforms.every((platform) =>
            dispatchedChildren.some((child) => child.platform === platform));
          row.dispatch_status = allRequestedDispatched
            ? 'dispatched'
            : 'manual_reconciliation';
          if (allRequestedDispatched) {
            row.dispatched_at ??= new Date().toISOString();
            row.error_at = null;
            row.error_message = null;
          } else {
            manualReconciliation += 1;
          }
        } else if (post && post.published_status !== 'published') {
          // Model the rejected-head sweep: it demoted canonical truth to
          // unverified even when a durable dispatched child carried a provider
          // id, and it always rolled the parent to manual reconciliation.
          post.published_status = 'unverified';
          manualReconciliation += 1;
        }
        swept += 1;
      }
      return { rows: [{ swept, manual_reconciliation: manualReconciliation }], rowCount: 1 };
    }

    if (s.startsWith('WITH canonical AS MATERIALIZED') && s.includes('owner.scheduled_for')) {
      // Dead-campaign sweep. No row in this fake carries a campaign_end_date,
      // so the sweep is always a structural no-op here; its real semantics are
      // covered by scheduled-posts-worker-campaign-sweep.test.ts.
      return { rows: [{ swept: 0, posts_expired: 0 }], rowCount: 1 };
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
  end?: () => Promise<void>;
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
    dispatch_attempt_token: null,
    dispatch_claimed_at: null,
    dispatch_started_at: null,
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  });
  db.posts.push({
    id: 100,
    tenant_id: 7,
    published_status: 'approved',
    platform_post_id: null,
    published_at: null,
  });
}

test('shutdown timeout env stays above provider I/O and below Compose grace', async () => {
  const { parseShutdownTimeoutMs } = await loadWorker();
  assert.equal(parseShutdownTimeoutMs(undefined), 350_000);
  assert.equal(parseShutdownTimeoutMs('345000'), 345_000);
  assert.equal(parseShutdownTimeoutMs('330000'), 350_000);
  assert.equal(parseShutdownTimeoutMs('360000'), 350_000);
  assert.equal(parseShutdownTimeoutMs('not-a-number'), 350_000);
});

test('image timeout exceeds the Instagram route ceiling and delayed success is recorded exactly once', async () => {
  const { resolveDispatchFetchTimeoutMs, tick } = await loadWorker();
  assert.ok(
    resolveDispatchFetchTimeoutMs('image') > 60_000,
    'the worker must wait beyond the complete Instagram image-container route ceiling',
  );

  const db = new FakeDb();
  seedDueRow(db);
  db.scheduled[0]!.target_platforms = ['instagram'];
  db.scheduled[0]!.media_type = 'image';

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const realFetch = globalThis.fetch;
  let providerSubmissions = 0;
  try {
    globalThis.fetch = (async () => {
      providerSubmissions += 1;
      // Exercise an actually delayed response without making the regression
      // sleep for a production minute; the exported timeout assertion above
      // proves the real margin over the former 30-second budget.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({
        status: 'ok',
        results: [{ provider: 'instagram', ok: true, platformPostId: 'ig_delayed_image_100' }],
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const report = await tick(makePool(db));
    assert.equal(report.dispatched, 1);
    assert.equal(providerSubmissions, 1, 'the immutable attempt token crosses provider dispatch once');
    assert.deepEqual(
      db.children.map((child) => [child.platform, child.status, child.platform_post_id]),
      [['instagram', 'dispatched', 'ig_delayed_image_100']],
    );
    assert.equal(db.posts[0]?.published_status, 'published');
    assert.equal(db.posts[0]?.platform_post_id, 'ig_delayed_image_100');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('worker sends one internal request and fails closed on ambiguous transport loss', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const realFetch = globalThis.fetch;
  try {
    // The route may have accepted the provider request before the connection
    // disappeared. A retry here could duplicate a live post.
    let observedDuringPublish: string | undefined;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
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
    assert.equal(fetchCalls, 1, 'a worker attempt must issue exactly one internal dispatch request');

    const row = db.scheduled[0];
    assert.equal(row.dispatch_status, 'manual_reconciliation');
    assert.match(row.error_message ?? '', /publish_outcome_unknown/);
    assert.ok(db.children.every((c) => c.status === 'manual_reconciliation'));
    assert.equal(db.posts[0]!.published_status, 'unverified');

    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('manual-reconciliation row must not be reclaimed');
    }) as typeof fetch;
    const restartReport = await tick(makePool(db));
    assert.equal(restartReport.processed, 0);
    assert.equal(fetchCalls, 1, 'automatic restart must not republish an ambiguous outcome');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('response loss reconciles every durable provider success without demoting or losing ids', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      const facebook = db.children.find((child) => child.platform === 'facebook');
      const instagram = db.children.find((child) => child.platform === 'instagram');
      assert.ok(facebook && instagram, 'the worker seeds both child rows before provider I/O');
      Object.assign(facebook, {
        status: 'dispatched',
        platform_post_id: 'fb_response_lost_100',
        dispatched_at: new Date().toISOString(),
      });
      Object.assign(instagram, {
        status: 'dispatched',
        platform_post_id: 'ig_response_lost_100',
        dispatched_at: new Date().toISOString(),
      });
      throw new Error('route response body lost after durable success commit');
    }) as typeof fetch;

    const report = await tick(makePool(db));
    assert.equal(report.dispatched, 1);
    assert.deepEqual(
      db.children.map((child) => [child.platform, child.status, child.platform_post_id]),
      [
        ['facebook', 'dispatched', 'fb_response_lost_100'],
        ['instagram', 'dispatched', 'ig_response_lost_100'],
      ],
    );
    assert.equal(db.scheduled[0]!.dispatch_status, 'dispatched');
    assert.equal(db.posts[0]!.published_status, 'published');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('known terminal provider rejection dead-letters and counts canonical delivery failure', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      results: [
        { provider: 'facebook', ok: false, retryable: false, kind: 'validation', error: 'invalid media' },
        { provider: 'instagram', ok: false, retryable: false, kind: 'validation', error: 'invalid media' },
      ],
    }), { status: 422, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const report = await tick(makePool(db));
    assert.equal(db.scheduled[0]!.dispatch_status, 'dead_letter');
    assert.equal(db.scheduled[0]!.failure_class, 'media_invalid');
    assert.equal(report.deadLettered, 1);
    assert.equal(db.posts[0]!.published_status, 'failed');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('legacy orphaned schedules fail before provider I/O instead of remaining in flight', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  db.posts = [];
  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('orphan must not reach provider boundary');
    }) as typeof fetch;

    await tick(makePool(db));
    assert.equal(fetchCalls, 0);
    assert.equal(db.scheduled[0]!.dispatch_status, 'failed');
    assert.match(db.scheduled[0]!.error_message ?? '', /orphaned_schedule/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('transaction-bound pg-like clients are not mistaken for pools', async () => {
  let connectCalls = 0;
  const queryable = {
    release: () => {},
    connect: async () => {
      connectCalls += 1;
      throw new Error('already-connected client must not reconnect');
    },
    query: async (sql: string) => {
      if (sql.includes('FROM posts') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: 101 }], rowCount: 1 };
      }
      if (sql.trim().startsWith('WITH existing AS')) {
        return {
          rows: [{
            id: 1,
            post_id: 101,
            tenant_id: 7,
            scheduled_for: new Date('2026-07-27T12:00:00.000Z'),
            target_platforms: ['facebook'],
            updated_at: new Date('2026-07-26T12:00:00.000Z'),
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 40)}`);
    },
  };

  await upsertScheduledPost(queryable as never, {
    tenantId: 7,
    postId: 101,
    scheduledFor: new Date('2026-07-27T12:00:00.000Z'),
    platforms: ['facebook'],
  });
  assert.equal(connectCalls, 0);
});

test('known Facebook success survives route finalization failure and a later Instagram unknown outcome', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const requestedPlatforms: string[][] = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { platforms: string[] };
      requestedPlatforms.push(request.platforms);
      if (requestedPlatforms.length === 1) {
        return new Response(JSON.stringify({
          status: 'finalization_failed',
          results: [
            { provider: 'facebook', ok: true, platformPostId: 'fb_finalizer_failed_100' },
            {
              provider: 'instagram',
              ok: false,
              retryable: true,
              kind: 'transient',
              error: 'instagram temporarily unavailable',
            },
          ],
        }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        status: 'finalization_failed',
        results: [{
          provider: 'instagram',
          ok: false,
          retryable: false,
          kind: 'outcome_unknown',
          error: 'instagram provider response lost',
        }],
      }), { status: 503, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    await tick(makePool(db));
    assert.deepEqual(
      db.children.map((child) => [child.platform, child.status, child.platform_post_id]),
      [
        ['facebook', 'dispatched', 'fb_finalizer_failed_100'],
        ['instagram', 'pending', null],
      ],
    );
    assert.equal(db.posts[0]?.published_status, 'published');
    assert.equal(db.posts[0]?.platform_post_id, 'fb_finalizer_failed_100');

    await tick(makePool(db));
    assert.deepEqual(
      requestedPlatforms,
      [['facebook', 'instagram'], ['instagram']],
      'Facebook crosses provider I/O exactly once and is never automatically retried',
    );
    assert.deepEqual(
      db.children.map((child) => [child.platform, child.status, child.platform_post_id]),
      [
        ['facebook', 'dispatched', 'fb_finalizer_failed_100'],
        ['instagram', 'manual_reconciliation', null],
      ],
      'later Instagram failure cannot erase durable Facebook success or its id',
    );
    assert.equal(db.posts[0]?.published_status, 'published');
    assert.equal(db.posts[0]?.platform_post_id, 'fb_finalizer_failed_100');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a stale reclaim does NOT re-dispatch a dead-lettered platform', async () => {
  // F5(a): on a stale_in_flight reclaim, a platform whose child row is
  // 'dead_letter' (terminal, non-retryable) must be excluded from re-dispatch
  // set — exactly like a 'dispatched' platform. Re-sending it would risk a
  // duplicate publish if the original "failure" was a false negative, and at
  // best wastes a Graph API call on a permanently-dead platform.
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  // The row is stale in_flight (past the reclaim window). FB already failed
  // terminally; IG is still in_flight (its worker pass crashed).
  db.scheduled[0].dispatch_status = 'in_flight';
  db.scheduled[0].dispatch_claimed_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.children.push(
    {
      scheduled_post_id: 1,
      platform: 'facebook',
      status: 'dead_letter',
      platform_post_id: null,
      dispatched_at: null,
      error_at: new Date().toISOString(),
      error_message: 'media_invalid',
    },
    {
      scheduled_post_id: 1,
      platform: 'instagram',
      status: 'in_flight',
      platform_post_id: null,
      dispatched_at: null,
      error_at: null,
      error_message: null,
    },
  );

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  let dispatchedPlatforms: string[] = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: unknown, init: { body?: unknown }) => {
      const sent = JSON.parse(String(init.body)) as { platforms: string[] };
      dispatchedPlatforms = sent.platforms;
      return new Response(
        JSON.stringify({
          status: 'ok',
          results: sent.platforms.map((p: string) => ({ provider: p, ok: true })),
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await tick(makePool(db));

    assert.deepEqual(
      dispatchedPlatforms,
      ['instagram'],
      'only the non-terminal platform is re-dispatched; the failed FB child is excluded',
    );
    const fb = db.children.find((c) => c.platform === 'facebook');
    assert.equal(fb?.status, 'dead_letter', 'the dead-lettered FB child stays terminal, never reset');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a fresh in_flight row (within the reclaim window) is NOT stolen by another pass', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  // A row currently in flight, claimed seconds ago — a live publish in progress.
  db.scheduled[0].dispatch_status = 'in_flight';
  db.scheduled[0].dispatch_claimed_at = new Date().toISOString();

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

test('a reclaimed attempt fences stale child outcomes, provider ids, and parent rollup', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const realFetch = globalThis.fetch;
  const realDateNow = Date.now;
  let logicalNow = realDateNow();
  let fetchCalls = 0;
  let signalStalePublishStarted!: () => void;
  const stalePublishStarted = new Promise<void>((resolve) => {
    signalStalePublishStarted = resolve;
  });
  let releaseStalePublish!: (response: Response) => void;
  const stalePublishResponse = new Promise<Response>((resolve) => {
    releaseStalePublish = resolve;
  });

  try {
    Date.now = () => logicalNow;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        signalStalePublishStarted();
        return stalePublishResponse;
      }
      return new Response(
        JSON.stringify({
          status: 'ok',
          results: [
            { provider: 'facebook', ok: true, platformPostId: 'fb_winner_100' },
            { provider: 'instagram', ok: true, platformPostId: 'ig_winner_100' },
          ],
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const staleTick = tick(makePool(db));
    await stalePublishStarted;

    // Advance the worker's reclaim clock without mutating the stored claim
    // timestamp: attempt 1 is now stale, and attempt 2 takes ownership.
    logicalNow += 60 * 60 * 1000;
    const winnerReport = await tick(makePool(db));
    assert.equal(winnerReport.dispatched, 1);
    assert.equal(db.scheduled[0].dispatch_status, 'dispatched');
    assert.deepEqual(
      db.children.map((child) => [child.platform, child.status, child.platform_post_id]),
      [
        ['facebook', 'dispatched', 'fb_winner_100'],
        ['instagram', 'dispatched', 'ig_winner_100'],
      ],
    );

    // Attempt 1 finally resumes. Its FB success carries a different non-null
    // provider id, while its IG failure would demote both the child and parent
    // without an active-attempt ownership fence.
    releaseStalePublish(new Response(
      JSON.stringify({
        status: 'error',
        results: [
          { provider: 'facebook', ok: true, platformPostId: 'fb_stale_100' },
          { provider: 'instagram', ok: false, retryable: false, error: 'stale terminal failure' },
        ],
      }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    ));
    await staleTick;

    assert.deepEqual(
      db.children.map((child) => [child.platform, child.status, child.platform_post_id]),
      [
        ['facebook', 'dispatched', 'fb_winner_100'],
        ['instagram', 'dispatched', 'ig_winner_100'],
      ],
      'the stale attempt cannot replace the first durable id or demote either child',
    );
    assert.equal(
      db.scheduled[0].dispatch_status,
      'dispatched',
      'the stale attempt cannot recompute and demote the newer parent rollup',
    );
  } finally {
    Date.now = realDateNow;
    globalThis.fetch = realFetch;
  }
});

// --- Retry backoff write site (2026-07-13 incident) --------------------------
// The pure classifier and the due/claim SQL are covered by
// scheduled-posts-worker-backoff.test.ts; these two pin the WRITE SITE in
// tick(): a non-terminal rollup must persist next_attempt_at in the
// post-publish transaction. Without this, deleting the tick() else-branch
// would keep every other test green while restoring the 60s retry hammer.

test('an ambiguous transport failure bypasses automatic retry backoff', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error('transient network failure');
    }) as typeof fetch;

    await tick(makePool(db));

    assert.equal(db.scheduled[0].dispatch_status, 'manual_reconciliation');
    assert.equal(
      db.scheduled[0].next_attempt_backoff_minutes,
      undefined,
      'ambiguous outcomes are terminally quarantined instead of scheduled for retry',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a known pre-provider 401 response is retryable and never quarantined as an unknown publish', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: 'invalid_internal_auth' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

    await tick(makePool(db));

    assert.equal(db.scheduled[0]!.dispatch_status, 'pending');
    assert.ok(db.children.every((child) => child.status === 'pending'));
    assert.equal(db.scheduled[0]!.next_attempt_backoff_minutes, 10);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an app with no internal secret is pre-provider retryable and never marked manual', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'worker-secret';

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: 'internal_api_secret_not_configured' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

    await tick(makePool(db));

    assert.equal(db.scheduled[0]!.dispatch_status, 'pending');
    assert.ok(db.children.every((child) => child.status === 'pending'));
    assert.equal(db.scheduled[0]!.next_attempt_backoff_minutes, 10);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a platform rate-limit failure (FB 368) writes the long rate-limit backoff', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: 'error',
          results: [
            {
              provider: 'facebook',
              ok: false,
              retryable: true,
              error:
                'Composio tool FACEBOOK_CREATE_PHOTO_POST failed: Facebook API error (code 368): We limit how often you can post. You can try again later.',
            },
            { provider: 'instagram', ok: true },
          ],
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    await tick(makePool(db));

    assert.equal(db.scheduled[0].dispatch_status, 'pending', 'FB child retryable → parent non-terminal');
    assert.equal(
      db.scheduled[0].next_attempt_backoff_minutes,
      180,
      'rate-limit tier backoff persisted — no more 60s hammering against FB 368',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a mixed unknown and retryable provider outcome retries only the bounded-safe child then settles for manual review', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  const requestedPlatforms: string[][] = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { platforms: string[] };
      requestedPlatforms.push(body.platforms);
      if (requestedPlatforms.length === 1) {
        return new Response(JSON.stringify({
          status: 'error',
          results: [
            {
              provider: 'facebook',
              ok: false,
              retryable: false,
              kind: 'outcome_unknown',
              error: 'provider accepted request but response was lost',
            },
            {
              provider: 'instagram',
              ok: false,
              retryable: true,
              kind: 'pre_provider',
              error: 'provider was not reached',
            },
          ],
        }), { status: 502, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        status: 'ok',
        results: [{ provider: 'instagram', ok: true, platformPostId: 'ig-safe-retry' }],
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    await tick(makePool(db));
    assert.equal(
      db.scheduled[0]!.dispatch_status,
      'pending',
      'a retryable sibling keeps the parent claimable despite another child requiring manual review',
    );
    assert.deepEqual(
      db.children.map((child) => [child.platform, child.status]),
      [
        ['facebook', 'manual_reconciliation'],
        ['instagram', 'pending'],
      ],
    );
    assert.equal(
      db.posts[0]!.published_status,
      'unverified',
      'manual child evidence makes canonical truth unverified even while a safe sibling remains retryable',
    );
    assert.equal(db.scheduled[0]!.next_attempt_backoff_minutes, 10);

    await tick(makePool(db));
    assert.deepEqual(
      requestedPlatforms,
      [['facebook', 'instagram'], ['instagram']],
      'the unknown Facebook outcome is never redispatched; only the bounded-safe child retries',
    );
    assert.deepEqual(
      db.children.map((child) => [child.platform, child.status, child.platform_post_id]),
      [
        ['facebook', 'manual_reconciliation', null],
        ['instagram', 'dispatched', 'ig-safe-retry'],
      ],
    );
    assert.equal(
      db.scheduled[0]!.dispatch_status,
      'manual_reconciliation',
      'after all safe retries finish the parent settles to the remaining manual-review outcome',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('rescheduling metadata during a live publish cannot invalidate completion or cause a duplicate reclaim', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);

  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  let publishStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    publishStarted = resolve;
  });
  let releasePublish!: () => void;
  const release = new Promise<void>((resolve) => {
    releasePublish = resolve;
  });
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input, init) => {
      fetchCalls += 1;
      const requestBody = JSON.parse(String(init?.body)) as {
        post_id?: string;
        scheduled_post_id?: string;
        dispatch_attempt_token?: string;
      };
      assert.equal(requestBody.post_id, '100');
      assert.equal(requestBody.scheduled_post_id, '1');
      assert.equal(
        requestBody.dispatch_attempt_token,
        db.scheduled[0]!.dispatch_attempt_token,
        'the route request carries the immutable claim token owned by this worker generation',
      );
      publishStarted();
      await release;
      return new Response(
        JSON.stringify({
          status: 'ok',
          results: [
            { provider: 'facebook', ok: true, platformPostId: 'fb_live_reschedule_1' },
            { provider: 'instagram', ok: true, platformPostId: 'ig_live_reschedule_1' },
          ],
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const inProgressTick = tick(makePool(db));
    await started;

    const liveRow = db.scheduled[0]!;
    assert.equal(liveRow.dispatch_status, 'in_flight');
    // A scheduling/metadata write is allowed to touch updated_at. Attempt
    // ownership must be independent of that mutable business timestamp.
    liveRow.updated_at = db.nextUpdatedAt();
    liveRow.caption = 'rescheduled metadata update';

    releasePublish();
    await inProgressTick;

    assert.equal(db.scheduled[0]!.dispatch_status, 'dispatched', 'the live owner still completes terminally');
    assert.ok(db.children.every((child) => child.status === 'dispatched'));

    // Even if the mutable timestamp is old enough for the legacy reclaim
    // predicate, a terminal row cannot be reclaimed and re-published.
    db.scheduled[0]!.updated_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await tick(makePool(db));
    assert.equal(fetchCalls, 1, 'exactly one provider publish occurs');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('restart quarantines a stale provider-started attempt instead of republishing it', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  const row = db.scheduled[0]!;
  row.dispatch_status = 'in_flight';
  row.dispatch_attempt_token = 'attempt-unknown';
  row.dispatch_claimed_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  row.dispatch_started_at = new Date(Date.now() - 59 * 60 * 1000).toISOString();
  db.children.push(...row.target_platforms.map((platform) => ({
    scheduled_post_id: row.id,
    platform,
    status: 'in_flight',
    platform_post_id: null,
    dispatched_at: null,
    error_at: null,
    error_message: null,
  })));

  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('stale started attempt must never cross provider I/O again');
    }) as typeof fetch;

    const report = await tick(makePool(db));
    assert.equal(report.manualReconciliation, 1);
    assert.equal(report.processed, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(row.dispatch_status, 'manual_reconciliation');
    assert.ok(db.children.every((child) => child.status === 'manual_reconciliation'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('restart preserves one durable provider success and quarantines only the unresolved child', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  const row = db.scheduled[0]!;
  row.dispatch_status = 'in_flight';
  row.dispatch_attempt_token = 'attempt-partial-restart';
  row.dispatch_claimed_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  row.dispatch_started_at = new Date(Date.now() - 59 * 60 * 1000).toISOString();
  db.children.push(
    {
      scheduled_post_id: row.id,
      platform: 'facebook',
      status: 'dispatched',
      platform_post_id: 'fb-before-restart-100',
      dispatched_at: new Date(Date.now() - 58 * 60 * 1000).toISOString(),
      error_at: null,
      error_message: null,
    },
    {
      scheduled_post_id: row.id,
      platform: 'instagram',
      status: 'in_flight',
      platform_post_id: null,
      dispatched_at: null,
      error_at: null,
      error_message: null,
    },
  );

  const providerCalls = new Map<string, number>([['facebook', 1], ['instagram', 0]]);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { platforms?: string[] };
      for (const platform of request.platforms ?? []) {
        providerCalls.set(platform, (providerCalls.get(platform) ?? 0) + 1);
      }
      throw new Error('restart reconciliation must not cross provider I/O');
    }) as typeof fetch;

    const firstRestart = await tick(makePool(db));
    assert.equal(firstRestart.manualReconciliation, 1);
    assert.equal(firstRestart.processed, 0);
    assert.deepEqual(
      db.children.map((child) => [child.platform, child.status, child.platform_post_id]),
      [
        ['facebook', 'dispatched', 'fb-before-restart-100'],
        ['instagram', 'manual_reconciliation', null],
      ],
      'confirmed Facebook evidence survives while only unresolved Instagram is quarantined',
    );
    assert.equal(row.dispatch_status, 'manual_reconciliation');
    assert.equal(db.posts[0]!.published_status, 'published');
    assert.equal(db.posts[0]!.platform_post_id, 'fb-before-restart-100');

    const afterFirstRestart = JSON.stringify({
      scheduled: db.scheduled,
      children: db.children,
      posts: db.posts,
    });
    const secondRestart = await tick(makePool(db));
    assert.equal(secondRestart.manualReconciliation, 0);
    assert.equal(secondRestart.processed, 0);
    assert.equal(
      JSON.stringify({ scheduled: db.scheduled, children: db.children, posts: db.posts }),
      afterFirstRestart,
      'repeated restart reconciliation is idempotent',
    );
    assert.deepEqual(
      Object.fromEntries(providerCalls),
      { facebook: 1, instagram: 0 },
      'the immutable attempt token never causes a provider replay',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('restart rolls a fully durable started attempt forward without replaying either provider', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  const row = db.scheduled[0]!;
  row.dispatch_status = 'in_flight';
  row.dispatch_attempt_token = 'attempt-complete-restart';
  row.dispatch_claimed_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  row.dispatch_started_at = new Date(Date.now() - 59 * 60 * 1000).toISOString();
  db.children.push(
    {
      scheduled_post_id: row.id,
      platform: 'facebook',
      status: 'dispatched',
      platform_post_id: 'fb-complete-restart-100',
      dispatched_at: new Date(Date.now() - 58 * 60 * 1000).toISOString(),
      error_at: null,
      error_message: null,
    },
    {
      scheduled_post_id: row.id,
      platform: 'instagram',
      status: 'dispatched',
      platform_post_id: 'ig-complete-restart-100',
      dispatched_at: new Date(Date.now() - 57 * 60 * 1000).toISOString(),
      error_at: null,
      error_message: null,
    },
  );

  const providerCalls = new Map<string, number>([['facebook', 1], ['instagram', 1]]);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { platforms?: string[] };
      for (const platform of request.platforms ?? []) {
        providerCalls.set(platform, (providerCalls.get(platform) ?? 0) + 1);
      }
      throw new Error('fully durable restart must not cross provider I/O');
    }) as typeof fetch;

    const firstRestart = await tick(makePool(db));
    assert.equal(firstRestart.manualReconciliation, 0);
    assert.equal(firstRestart.processed, 0);
    assert.equal(row.dispatch_status, 'dispatched');
    assert.ok(db.children.every((child) => child.status === 'dispatched'));
    assert.deepEqual(
      db.children.map((child) => child.platform_post_id),
      ['fb-complete-restart-100', 'ig-complete-restart-100'],
      'every confirmed provider id survives restart finalization',
    );
    assert.equal(db.posts[0]!.published_status, 'published');
    assert.equal(db.posts[0]!.platform_post_id, 'fb-complete-restart-100');

    const afterFirstRestart = JSON.stringify({
      scheduled: db.scheduled,
      children: db.children,
      posts: db.posts,
    });
    const secondRestart = await tick(makePool(db));
    assert.equal(secondRestart.manualReconciliation, 0);
    assert.equal(secondRestart.processed, 0);
    assert.equal(
      JSON.stringify({ scheduled: db.scheduled, children: db.children, posts: db.posts }),
      afterFirstRestart,
      'repeated restart finalization is idempotent',
    );
    assert.deepEqual(
      Object.fromEntries(providerCalls),
      { facebook: 1, instagram: 1 },
      'each provider was called exactly once for the immutable attempt token',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('SIGTERM drain waits for accepted provider outcome recording before closing the pool', async () => {
  const { createScheduledPostsWorkerRuntime, tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  let releaseOutcome!: () => void;
  let outcomeWriteStartedResolve!: () => void;
  const outcomeWriteStarted = new Promise<void>((resolve) => {
    outcomeWriteStartedResolve = resolve;
  });
  const outcomeGate = new Promise<void>((resolve) => {
    releaseOutcome = resolve;
  });
  let hookCalls = 0;
  db.beforeOutcomeWrite = async () => {
    hookCalls += 1;
    if (hookCalls === 1) {
      outcomeWriteStartedResolve();
      await outcomeGate;
    }
  };

  let poolEnded = false;
  const pool: FakePool = {
    ...makePool(db),
    end: async () => {
      poolEnded = true;
    },
  };
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        results: [
          { provider: 'facebook', ok: true, platformPostId: 'fb-drained' },
          { provider: 'instagram', ok: true, platformPostId: 'ig-drained' },
        ],
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const runtime = createScheduledPostsWorkerRuntime(pool);
    const activeTick = runtime.runTick();
    await outcomeWriteStarted;
    const draining = runtime.shutdown(5_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(poolEnded, false, 'pool stays open while the accepted outcome is being recorded');

    releaseOutcome();
    assert.equal(await draining, true);
    await activeTick;
    assert.equal(poolEnded, true);
    assert.equal(db.scheduled[0]!.dispatch_status, 'dispatched');

    await tick(makePool(db));
    assert.equal(fetchCalls, 1, 'a restarted worker sees the durable terminal row and does not republish');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('shutdown during a prefetched batch drains the active row without claiming or publishing later rows', async () => {
  const { createScheduledPostsWorkerRuntime } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  db.scheduled.push({
    ...db.scheduled[0]!,
    id: 2,
    post_id: 102,
    caption: 'second prefetched post',
    dispatch_attempt_token: null,
    dispatch_claimed_at: null,
    dispatch_started_at: null,
  });
  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  let signalFirstPublish!: () => void;
  const firstPublishStarted = new Promise<void>((resolve) => {
    signalFirstPublish = resolve;
  });
  let releaseFirstPublish!: () => void;
  const firstPublishGate = new Promise<void>((resolve) => {
    releaseFirstPublish = resolve;
  });

  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        signalFirstPublish();
        await firstPublishGate;
      }
      return new Response(JSON.stringify({
        results: [
          { provider: 'facebook', ok: true, platformPostId: `fb-drain-${fetchCalls}` },
          { provider: 'instagram', ok: true, platformPostId: `ig-drain-${fetchCalls}` },
        ],
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const runtime = createScheduledPostsWorkerRuntime(makePool(db));
    const activeTick = runtime.runTick();
    await firstPublishStarted;
    const draining = runtime.shutdown(5_000);
    releaseFirstPublish();

    assert.equal(await draining, true);
    await activeTick;
    assert.equal(fetchCalls, 1, 'shutdown must not start provider work for the prefetched second row');
    assert.equal(db.scheduled.find((row) => row.id === 1)?.dispatch_status, 'dispatched');
    assert.equal(db.scheduled.find((row) => row.id === 2)?.dispatch_status, 'pending');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('shutdown while the pre-provider claim commit awaits releases the claim without starting provider I/O', async () => {
  const { createScheduledPostsWorkerRuntime } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  process.env.APP_BASE_URL = 'https://aries.example.test';
  process.env.INTERNAL_API_SECRET = 'test-secret';

  let signalClaimCommit!: () => void;
  const claimCommitStarted = new Promise<void>((resolve) => {
    signalClaimCommit = resolve;
  });
  let releaseClaimCommit!: () => void;
  const claimCommitGate = new Promise<void>((resolve) => {
    releaseClaimCommit = resolve;
  });
  db.beforeClaimCommit = async () => {
    signalClaimCommit();
    await claimCommitGate;
  };

  let poolEnded = false;
  const pool: FakePool = {
    ...makePool(db),
    end: async () => {
      poolEnded = true;
    },
  };
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ results: [] }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const runtime = createScheduledPostsWorkerRuntime(pool);
    const activeTick = runtime.runTick();
    await claimCommitStarted;
    const draining = runtime.shutdown(5_000);
    releaseClaimCommit();

    assert.equal(await draining, true);
    await activeTick;
    assert.equal(fetchCalls, 0, 'a signal delivered while COMMIT awaits closes the last claim-to-dispatch gap');
    assert.equal(db.scheduled[0]!.dispatch_status, 'pending');
    assert.equal(db.scheduled[0]!.dispatch_attempt_token, null);
    assert.equal(db.scheduled[0]!.dispatch_claimed_at, null);
    assert.ok(db.children.every((child) => child.status === 'pending'));
    assert.equal(poolEnded, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a partial-success reschedule is rejected and never republishes the successful platform', async () => {
  const { tick } = await loadWorker();
  const db = new FakeDb();
  seedDueRow(db);
  const row = db.scheduled[0]!;
  row.dispatch_status = 'failed';
  row.dispatch_attempt_token = 'terminal-attempt';
  row.dispatch_claimed_at = '2025-01-01T00:00:00.000Z';
  row.dispatch_started_at = '2025-01-01T00:00:01.000Z';
  row.dispatched_at = null;
  row.error_at = '2025-01-01T00:00:03.000Z';
  row.error_message = 'instagram failed after facebook published';
  row.next_attempt_backoff_minutes = 180;
  db.children.push(
    {
      scheduled_post_id: row.id,
      platform: 'facebook',
      status: 'dispatched',
      platform_post_id: 'facebook-confirmed-123',
      dispatched_at: '2025-01-01T00:00:02.000Z',
      error_at: null,
      error_message: null,
    },
    {
      scheduled_post_id: row.id,
      platform: 'instagram',
      status: 'failed',
      platform_post_id: null,
      dispatched_at: null,
      error_at: row.error_at,
      error_message: 'provider rejected publish',
    },
  );

  await assert.rejects(
    upsertScheduledPost(
      ({
        query: async (sql: string) => {
          if (sql.trim().startsWith('WITH existing AS')) {
            assert.match(sql, /terminal_dispatch_evidence AS MATERIALIZED/);
            assert.match(sql, /status IN \('dispatched', 'manual_reconciliation'\)/);
            return { rows: [], rowCount: 0 };
          }
          return {
            rows: [{
              dispatch_status: row.dispatch_status,
              has_manual_reconciliation: false,
              has_terminal_dispatch_evidence: true,
            }],
            rowCount: 1,
          };
        },
      } as never),
      {
        tenantId: 15,
        postId: 101,
        scheduledFor: new Date('2025-02-01T00:00:00.000Z'),
        platforms: ['facebook', 'instagram'],
      },
    ),
    /scheduled_post_dispatch_evidence/,
  );

  let internalRequests = 0;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      internalRequests += 1;
      return new Response(null, { status: 500 });
    }) as typeof fetch;

    await tick(makePool(db));
    assert.equal(internalRequests, 0);
    assert.equal(row.dispatch_status, 'failed');
    assert.equal(db.children.length, 2);
    assert.equal(db.children[0]!.status, 'dispatched');
    assert.equal(db.children[0]!.platform_post_id, 'facebook-confirmed-123');
    assert.equal(db.children[1]!.status, 'failed');
  } finally {
    globalThis.fetch = realFetch;
  }
});
