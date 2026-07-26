import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  claimScheduledDispatchProviderSubmission,
  finalizeScheduledDispatchAttempt,
} from '../app/api/internal/publishing/scheduled-dispatch/route';

type DispatchDb = Parameters<typeof finalizeScheduledDispatchAttempt>[0]['db'];

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.locked = true;
    return () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.locked = false;
    };
  }
}

class LockedOwnerFixture {
  readonly mutex = new Mutex();
  token = 'attempt-stale';
  status = 'in_flight';
  dispatchStartedAt: string | null = null;
  canonicalWrites = 0;
  insightsWrites = 0;
  providerClaims = 0;
  lockOrder: string[] = [];

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    return this.handleQuery(sql, params, false, { releaseLock: null, stagedToken: null });
  }

  async connect(): Promise<LockedOwnerClient> {
    return new LockedOwnerClient(this);
  }

  async handleQuery(
    sql: string,
    params: unknown[],
    transactional: boolean,
    state: { releaseLock: (() => void) | null; stagedToken: string | null },
  ): Promise<QueryResult> {
    const text = sql.trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT[\s\S]+FROM posts[\s\S]+FOR UPDATE/i.test(text)) {
      if (!transactional) throw new Error('canonical lock must run on a transaction client');
      this.lockOrder.push('post');
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
    if (/SELECT[\s\S]+FROM scheduled_posts[\s\S]+FOR UPDATE/i.test(text)) {
      if (!transactional) throw new Error('parent lock must run on a transaction client');
      this.lockOrder.push('scheduled');
      state.releaseLock = await this.mutex.acquire();
      return {
        rows: [{
          dispatch_status: this.status,
          dispatch_attempt_token: state.stagedToken ?? this.token,
          dispatch_started_at: this.dispatchStartedAt,
        }],
        rowCount: 1,
      };
    }
    if (/UPDATE scheduled_posts[\s\S]+dispatch_started_at/i.test(text)) {
      this.dispatchStartedAt = new Date().toISOString();
      this.providerClaims += 1;
      return { rows: [{ dispatch_started_at: this.dispatchStartedAt }], rowCount: 1 };
    }
    if (/UPDATE posts/i.test(text)) {
      // This branch intentionally models the pre-fix EXISTS update: it can see
      // the old committed token while a reclaim transaction owns the parent lock.
      const attemptToken = String(params[4] ?? params[0] ?? '');
      if (attemptToken === this.token) {
        this.canonicalWrites += 1;
        return { rows: [{ job_id: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/UPDATE insights_posts/i.test(text)) {
      this.insightsWrites += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

class LockedOwnerClient {
  private releaseLock: (() => void) | null = null;
  private stagedToken: string | null = null;

  constructor(private readonly fixture: LockedOwnerFixture) {}

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const text = sql.trim();
    if (text === 'COMMIT') {
      if (this.stagedToken !== null) this.fixture.token = this.stagedToken;
      this.releaseLock?.();
      this.releaseLock = null;
      return { rows: [], rowCount: 0 };
    }
    if (text === 'ROLLBACK') {
      this.releaseLock?.();
      this.releaseLock = null;
      this.stagedToken = null;
      return { rows: [], rowCount: 0 };
    }
    const state = {
      releaseLock: this.releaseLock,
      stagedToken: this.stagedToken,
    };
    const result = await this.fixture.handleQuery(sql, params, true, state);
    this.releaseLock = state.releaseLock;
    this.stagedToken = state.stagedToken;
    return result;
  }

  stageReclaim(token: string): void {
    this.stagedToken = token;
  }

  release(): void {}
}

async function lockForReclaim(
  fixture: LockedOwnerFixture,
  replacementToken: string,
): Promise<{ client: LockedOwnerClient; release: () => Promise<void> }> {
  const client = await fixture.connect();
  await client.query('BEGIN');
  await client.query(
    `SELECT dispatch_status, dispatch_attempt_token
       FROM scheduled_posts
      WHERE id = $1
      FOR UPDATE`,
    [71],
  );
  client.stageReclaim(replacementToken);
  return {
    client,
    release: async () => {
      await client.query('COMMIT');
      client.release();
    },
  };
}

test('parent-first finalization loses cleanly when a reclaim commits first', async () => {
  const fixture = new LockedOwnerFixture();
  const reclaim = await lockForReclaim(fixture, 'attempt-winner');
  fixture.lockOrder = [];

  const finalizing = finalizeScheduledDispatchAttempt({
    db: fixture as unknown as DispatchDb,
    scheduledPostId: '71',
    attemptToken: 'attempt-stale',
    tenantId: '15',
    postId: '901',
    postStatus: 'published',
    results: [{ provider: 'facebook', ok: true, platformPostId: 'fb_stale_901' }],
  });

  await reclaim.release();
  const result = await finalizing;

  assert.equal(result.owned, false);
  assert.equal(fixture.canonicalWrites, 0, 'stale finalizer cannot mutate canonical post state');
  assert.equal(fixture.insightsWrites, 0, 'stale finalizer cannot stamp Insights attribution');
  assert.deepEqual(fixture.lockOrder, ['post', 'scheduled'], 'finalization uses canonical-parent-first lock order');
});

test('an attempt token has exactly one provider-submission claim', async () => {
  const fixture = new LockedOwnerFixture();

  const first = await claimScheduledDispatchProviderSubmission({
    db: fixture as unknown as DispatchDb,
    scheduledPostId: '71',
    attemptToken: 'attempt-stale',
    tenantId: '15',
    postId: '901',
  });
  const second = await claimScheduledDispatchProviderSubmission({
    db: fixture as unknown as DispatchDb,
    scheduledPostId: '71',
    attemptToken: 'attempt-stale',
    tenantId: '15',
    postId: '901',
  });

  assert.deepEqual(first, { owned: true, claimed: true });
  assert.deepEqual(second, { owned: true, claimed: false });
  assert.equal(fixture.providerClaims, 1);
});

test('canonical published status is monotonic across later sibling failure and outcome-unknown attempts', () => {
  const routeSource = readFileSync(
    path.join(REPO_ROOT, 'app/api/internal/publishing/scheduled-dispatch/route.ts'),
    'utf8',
  );

  assert.match(
    routeSource,
    /published_status\s*=\s*CASE[\s\S]*published_status\s*=\s*'published'[\s\S]*scheduled_post_dispatches[\s\S]*status\s*=\s*'dispatched'[\s\S]*THEN\s+'published'/i,
    'durable Facebook success must keep the canonical post published when a later Instagram attempt fails or is unverified',
  );
  assert.match(
    routeSource,
    /ELSE\s+\$\d+[\s\S]*END/i,
    'only a post with no durable success may accept the current failed/unverified outcome',
  );
});
