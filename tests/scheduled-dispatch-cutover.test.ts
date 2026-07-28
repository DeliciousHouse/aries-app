import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type CutoverResult = {
  scheduledPosts: number;
  platformDispatches: number;
  postsUnverified: number;
};

type ScheduledDispatchCutoverClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
};

const { quarantineLegacyScheduledDispatches } = require('../scripts/scheduled-dispatch-cutover.js') as {
  quarantineLegacyScheduledDispatches: (
    client: ScheduledDispatchCutoverClient,
  ) => Promise<CutoverResult>;
};
const {
  LEGACY_UNKNOWN_OUTCOME_PREFIXES,
  LEGACY_UNKNOWN_OUTCOME_SQL_REGEX,
} = require('../scripts/legacy-scheduled-dispatch-unknown-outcomes.js') as {
  LEGACY_UNKNOWN_OUTCOME_PREFIXES: readonly string[];
  LEGACY_UNKNOWN_OUTCOME_SQL_REGEX: string;
};

const HISTORICAL_UNKNOWN_OUTCOME_PREFIXES = [
  'video_publish_outcome_unknown',
  'provider_publish_outcome_unknown',
  'provider_publish_missing_id',
  'facebook_video_publish_missing_id',
  'facebook_video_story_finish_missing_id',
  'facebook_story_publish_missing_id',
  'facebook_publish_missing_id',
  'instagram_publish_missing_id',
] as const;

type LegacyRow = {
  id: number;
  dispatchStatus: 'pending' | 'in_flight' | 'failed' | 'manual_reconciliation';
  dispatchStartedAt: string | null;
  legacyTransportAmbiguous?: boolean;
  failedUnknownChild?: boolean;
  unsafeChildStatus?: 'failed' | 'manual_reconciliation';
  canonicalStatus?: 'approved' | 'unverified';
};

class CutoverFixture implements ScheduledDispatchCutoverClient {
  readonly rows: LegacyRow[] = [];
  commits = 0;
  rollbacks = 0;

  async query(sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const normalized = sql.trim();
    if (normalized === 'BEGIN') return { rows: [], rowCount: 0 };
    if (normalized === 'COMMIT') {
      this.commits += 1;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'ROLLBACK') {
      this.rollbacks += 1;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('SET LOCAL lock_timeout')) return { rows: [], rowCount: 0 };
    if (normalized.startsWith('ALTER TABLE scheduled_posts')) return { rows: [], rowCount: 0 };
    if (normalized.includes('quarantined_dispatches AS')) {
      const recognizesLegacyPendingAmbiguity = normalized.includes('legacy_transport_ambiguous')
        && normalized.includes('graph_network_error')
        && normalized.includes('graph_api_error');
      const recognizesLegacyFailedAmbiguity = normalized.includes("dispatch.status = 'failed'")
        && HISTORICAL_UNKNOWN_OUTCOME_PREFIXES.every((prefix) => normalized.includes(prefix));
      const recognizesLegacyFailedAmbiguityForPendingParent = normalized.includes(
        "owner.dispatch_status IN ('pending', 'failed')",
      ) && HISTORICAL_UNKNOWN_OUTCOME_PREFIXES.every((prefix) => normalized.includes(prefix));
      const legacy = this.rows.filter(
        (row) =>
          (row.dispatchStatus === 'in_flight' && row.dispatchStartedAt === null)
          || (
            recognizesLegacyPendingAmbiguity
            && row.dispatchStatus === 'pending'
            && row.legacyTransportAmbiguous === true
          )
          || (
            recognizesLegacyFailedAmbiguity
            && row.dispatchStatus === 'failed'
            && row.legacyTransportAmbiguous === true
          )
          || (
            recognizesLegacyFailedAmbiguityForPendingParent
            && row.dispatchStatus === 'pending'
            && row.failedUnknownChild === true
          ),
      );
      for (const row of legacy) {
        row.dispatchStatus = 'manual_reconciliation';
        row.canonicalStatus = 'unverified';
        if (row.unsafeChildStatus === 'failed') row.unsafeChildStatus = 'manual_reconciliation';
      }
      return {
        rows: [{
          scheduled_posts: legacy.length,
          platform_dispatches: legacy.length * 2,
          posts_unverified: legacy.length,
        }],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected cutover SQL: ${normalized.slice(0, 80)}`);
  }
}

test('legacy unknown-outcome classification is shared and exhaustive for every pre-fence code', () => {
  assert.deepEqual(
    LEGACY_UNKNOWN_OUTCOME_PREFIXES,
    HISTORICAL_UNKNOWN_OUTCOME_PREFIXES,
  );
  const classifier = new RegExp(LEGACY_UNKNOWN_OUTCOME_SQL_REGEX);
  for (const prefix of HISTORICAL_UNKNOWN_OUTCOME_PREFIXES) {
    assert.match(`${prefix}: provider response`, classifier, prefix);
  }

  const cutoverSource = readFileSync(
    path.join(REPO_ROOT, 'scripts', 'scheduled-dispatch-cutover.js'),
    'utf8',
  );
  const restoreProofSource = readFileSync(
    path.join(REPO_ROOT, 'scripts', 'release', 'assert-no-unresolved-scheduled-claims.mjs'),
    'utf8',
  );
  for (const source of [cutoverSource, restoreProofSource]) {
    assert.match(source, /legacy-scheduled-dispatch-unknown-outcomes/);
    assert.match(source, /LEGACY_UNKNOWN_OUTCOME_SQL_REGEX/);
  }
});

test('two deploys quarantine a legacy row created after deploy-one rollback restores the old worker', async () => {
  const fixture = new CutoverFixture();
  fixture.rows.push({ id: 1, dispatchStatus: 'in_flight', dispatchStartedAt: null });

  const deployOne = await quarantineLegacyScheduledDispatches(fixture);
  assert.deepEqual(deployOne, {
    scheduledPosts: 1,
    platformDispatches: 2,
    postsUnverified: 1,
  });
  assert.equal(fixture.rows[0]?.dispatchStatus, 'manual_reconciliation');

  // A later deploy gate fails and restores the exact pre-fence worker. That old
  // worker can create another in-flight row without dispatch_started_at.
  fixture.rows.push({ id: 2, dispatchStatus: 'in_flight', dispatchStartedAt: null });

  const deployTwo = await quarantineLegacyScheduledDispatches(fixture);
  assert.equal(deployTwo.scheduledPosts, 1);
  assert.equal(fixture.rows[1]?.dispatchStatus, 'manual_reconciliation');
  assert.equal(fixture.commits, 2, 'the idempotent quarantine runs on every deploy/start');
  assert.equal(fixture.rollbacks, 0);
});

test('cutover never quarantines a provider-fenced in-flight attempt', async () => {
  const fixture = new CutoverFixture();
  fixture.rows.push({
    id: 3,
    dispatchStatus: 'in_flight',
    dispatchStartedAt: '2026-07-25T00:00:00.000Z',
  });

  const result = await quarantineLegacyScheduledDispatches(fixture);
  assert.deepEqual(result, {
    scheduledPosts: 0,
    platformDispatches: 0,
    postsUnverified: 0,
  });
  assert.equal(fixture.rows[0]?.dispatchStatus, 'in_flight');
});

test('cutover quarantines legacy pending transport ambiguity but leaves safe pending work claimable', async () => {
  const fixture = new CutoverFixture();
  fixture.rows.push(
    {
      id: 4,
      dispatchStatus: 'pending',
      dispatchStartedAt: null,
      legacyTransportAmbiguous: true,
    },
    {
      id: 5,
      dispatchStatus: 'pending',
      dispatchStartedAt: null,
      legacyTransportAmbiguous: false,
    },
  );

  const result = await quarantineLegacyScheduledDispatches(fixture);
  assert.deepEqual(result, {
    scheduledPosts: 1,
    platformDispatches: 2,
    postsUnverified: 1,
  });
  assert.equal(fixture.rows[0]?.dispatchStatus, 'manual_reconciliation');
  assert.equal(fixture.rows[1]?.dispatchStatus, 'pending');
});

test('cutover quarantines legacy failed unknown outcomes but preserves known terminal failures', async () => {
  const fixture = new CutoverFixture();
  fixture.rows.push(
    {
      id: 6,
      dispatchStatus: 'failed',
      dispatchStartedAt: null,
      legacyTransportAmbiguous: true,
    },
    {
      id: 7,
      dispatchStatus: 'failed',
      dispatchStartedAt: null,
      legacyTransportAmbiguous: false,
    },
  );

  const result = await quarantineLegacyScheduledDispatches(fixture);
  assert.deepEqual(result, {
    scheduledPosts: 1,
    platformDispatches: 2,
    postsUnverified: 1,
  });
  assert.equal(fixture.rows[0]?.dispatchStatus, 'manual_reconciliation');
  assert.equal(fixture.rows[1]?.dispatchStatus, 'failed');
});

test('cutover quarantines a failed unknown child even when a retryable sibling keeps the parent pending', async () => {
  const fixture = new CutoverFixture();
  fixture.rows.push({
    id: 8,
    dispatchStatus: 'pending',
    dispatchStartedAt: null,
    failedUnknownChild: true,
    unsafeChildStatus: 'failed',
    canonicalStatus: 'approved',
  });

  const result = await quarantineLegacyScheduledDispatches(fixture);
  assert.deepEqual(result, {
    scheduledPosts: 1,
    platformDispatches: 2,
    postsUnverified: 1,
  });
  assert.equal(fixture.rows[0]?.dispatchStatus, 'manual_reconciliation');
  assert.equal(fixture.rows[0]?.unsafeChildStatus, 'manual_reconciliation');
  assert.equal(fixture.rows[0]?.canonicalStatus, 'unverified');
});

class TimedMutex {
  private locked = false;
  private waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  acquire(timeoutMs = 60): Promise<() => void> {
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

test('cutover and a live route share canonical-first locks without deadlock or partial outcome', async () => {
  const canonical = new TimedMutex();
  const scheduled = new TimedMutex();
  let releaseLive!: () => void;
  const allowLiveScheduledLock = new Promise<void>((resolve) => { releaseLive = resolve; });
  let signalLiveHasCanonical!: () => void;
  const liveHasCanonical = new Promise<void>((resolve) => { signalLiveHasCanonical = resolve; });

  const liveRoute = (async () => {
    const releaseCanonical = await canonical.acquire();
    signalLiveHasCanonical();
    try {
      await allowLiveScheduledLock;
      const releaseScheduled = await scheduled.acquire();
      releaseScheduled();
    } finally {
      releaseCanonical();
    }
  })();
  await liveHasCanonical;

  const client: ScheduledDispatchCutoverClient = {
    query: async (sql) => {
      const normalized = sql.trim();
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SET LOCAL lock_timeout')) return { rows: [], rowCount: 0 };

      const canonicalIndex = normalized.indexOf('FOR UPDATE OF post');
      const scheduledIndex = normalized.indexOf('FOR UPDATE OF scheduled');
      assert.ok(canonicalIndex >= 0 && scheduledIndex >= 0, 'cutover SQL must lock both canonical and scheduled rows');
      const lockOrder = canonicalIndex < scheduledIndex
        ? [canonical, scheduled]
        : [scheduled, canonical];
      const releases: Array<() => void> = [];
      try {
        for (const lock of lockOrder) releases.push(await lock.acquire());
        return {
          rows: [{ scheduled_posts: 1, platform_dispatches: 2, posts_unverified: 1 }],
          rowCount: 1,
        };
      } finally {
        for (const release of releases.reverse()) release();
      }
    },
  };

  const cutover = quarantineLegacyScheduledDispatches(client);
  // Let cutover attempt its first lock before the live route advances. A
  // scheduled-first cutover now forms the old parent↔child deadlock; a
  // canonical-first cutover simply waits behind live traffic.
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseLive();

  const [cutoverResult] = await Promise.all([cutover, liveRoute]);
  assert.deepEqual(cutoverResult, {
    scheduledPosts: 1,
    platformDispatches: 2,
    postsUnverified: 1,
  });
});

test('cutover runner logs every defined quarantine count from the helper contract', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'scripts/run-scheduled-dispatch-cutover.js'),
    'utf8',
  );
  for (const count of ['scheduledPosts', 'platformDispatches', 'postsUnverified']) {
    assert.match(source, new RegExp(`result\\.${count}`));
  }
  assert.doesNotMatch(source, /result\.quarantined/);
});

test('PostgreSQL safety fixtures use production TEXT tokens and feedback-postgres runs the real cutover CTE', () => {
  const claimFixture = readFileSync(
    path.join(REPO_ROOT, 'tests', 'scheduled-worker-claim-lock-order.test.ts'),
    'utf8',
  );
  const sweepFixture = readFileSync(
    path.join(REPO_ROOT, 'tests', 'scheduled-worker-sweep-lock-order.test.ts'),
    'utf8',
  );
  for (const fixture of [claimFixture, sweepFixture]) {
    assert.match(fixture, /dispatch_attempt_token TEXT/);
    assert.doesNotMatch(fixture, /dispatch_attempt_token UUID/);
  }

  const workflow = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'tests.yml'), 'utf8');
  assert.match(
    workflow,
    /feedback-postgres:[\s\S]*tests\/scheduled-dispatch-cutover\.requires-infra\.test\.ts/,
  );

  const postgresCutover = readFileSync(
    path.join(REPO_ROOT, 'tests', 'scheduled-dispatch-cutover.requires-infra.test.ts'),
    'utf8',
  );
  assert.match(postgresCutover, /quarantineLegacyScheduledDispatches/);
  assert.match(postgresCutover, /dispatch_attempt_token TEXT/);
});