import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

// Importing the worker is side-effect free: the isDirectRun guard means main()
// (and its setInterval / signal handlers) only runs under direct invocation.
import {
  tickSafe,
  type TickPool,
  type SyncAllAccountsFn,
} from '../scripts/automations/insights-sync-worker';
import {
  sweepAbandonedSyncRuns,
  strandedRunGraceMinutes,
  DEFAULT_STRANDED_RUN_GRACE_MINUTES,
  SWEEP_STRANDED_SYNC_RUNS_SQL,
} from '../backend/insights/sync/sweep-stranded-runs';
import { SYNC_RUN_TERMINAL_OK_SQL } from '../backend/insights/sync/dispatcher';

// Regression for the stranded-'running' sync runs found in the PR #581
// adversarial review: the dispatcher INSERTs each insights_sync_runs row with
// status='running' and only flips it at the end of a long multi-fetch
// sequence, while the worker's shutdown() ends the pool without awaiting an
// in-flight tick. A SIGTERM mid-tick (docker compose stop → 10s grace →
// SIGKILL) therefore stranded rows in status='running' forever — no reaper
// covers this table. The fix is a sweep at the top of every tick that fails
// out rows stuck in 'running' past a grace window.
//
// These tests are fully in-memory: they assert the SQL's shape and the tick
// wiring. The predicate's real behavior against the live schema is proven by
// tests/insights-sync-runs-sweep.requires-infra.test.ts.

const noopSync: SyncAllAccountsFn = async () => [];

/** Collapses whitespace so the SQL oracle tracks semantics, not indentation. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

type RecordedQuery = { sql: string; params?: unknown[] };

/** Fake pool that records every SQL statement and routes canned responses. */
function makeRecordingPool(opts?: {
  sweptCount?: number | null;
  tenantRows?: Array<{ tenant_id: number }>;
  failSweep?: boolean;
}) {
  const queries: RecordedQuery[] = [];
  let releaseCalls = 0;
  const pool: TickPool = {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (/UPDATE insights_sync_runs/.test(sql)) {
          if (opts?.failSweep) {
            throw new Error('relation "insights_sync_runs" does not exist');
          }
          // Preserve an explicit null — the null-rowCount test exercises the
          // sweep's own `rowCount ?? 0` coalesce, so the fake must not pre-coalesce.
          return {
            rows: [],
            rowCount: opts?.sweptCount === undefined ? 0 : opts.sweptCount,
          };
        }
        return { rows: opts?.tenantRows ?? [] };
      },
      release: () => {
        releaseCalls++;
      },
    }),
  };
  return {
    pool,
    queries,
    releaseCalls: () => releaseCalls,
  };
}

test('the sweep fails out only stranded running rows, behind a grace window', async () => {
  const { pool, queries, releaseCalls } = makeRecordingPool({ sweptCount: 3 });

  const swept = await sweepAbandonedSyncRuns(pool);
  assert.equal(swept, 3, 'returns the number of rows it failed out');
  assert.equal(queries.length, 1, 'the sweep is a single statement');
  assert.equal(releaseCalls(), 1, 'the pooled client is released');

  assert.equal(
    queries[0].sql,
    SWEEP_STRANDED_SYNC_RUNS_SQL,
    'the sweep executes the exported statement — the same one the requires-infra test proves',
  );
  assert.deepEqual(
    queries[0].params,
    // Compare against the parser, not a literal 60: the sweep reads
    // ARIES_INSIGHTS_SWEEP_GRACE_MINUTES from process.env at call time, and
    // this assertion is about the wiring (window passed as a parameter) —
    // the parser's values have their own test below.
    [strandedRunGraceMinutes()],
    'the grace window is passed as a parameter, not interpolated',
  );

  const sql = normalizeSql(SWEEP_STRANDED_SYNC_RUNS_SQL);
  assert.match(sql, /UPDATE insights_sync_runs/, 'targets the sync-runs table');
  assert.match(
    sql,
    /WHERE status = 'running'/,
    'only rows still stuck in running are eligible — never re-fails ok/partial/failed rows',
  );
  assert.match(
    sql,
    /started_at < now\(\) - make_interval\(mins => \$1\)/,
    'a grace window protects syncs genuinely in flight in another process',
  );
  assert.match(sql, /status = 'failed'/, 'stranded rows land in the existing failed status');
  assert.match(
    sql,
    /error_message = 'aborted by worker restart'/,
    'the error message identifies restart-abort so it is distinguishable from adapter failures',
  );
  assert.match(sql, /finished_at = now\(\)/, 'the run is closed out, not left open-ended');
});

test("the dispatcher's terminal ok UPDATE clears the sweep's abort message", () => {
  // A run swept mid-flight that then completes must end clean: status='ok'
  // with error_message='aborted by worker restart' left behind would be a
  // self-contradictory audit row. Behavior is proven against real Postgres in
  // the requires-infra test; this keeps the shape in the fast verify gate.
  const sql = normalizeSql(SYNC_RUN_TERMINAL_OK_SQL);
  assert.match(sql, /status = 'ok'/, 'the ok path marks the run ok');
  assert.match(
    sql,
    /error_message = NULL/,
    'the ok path clears any abort message a mid-flight sweep wrote',
  );
  assert.match(sql, /WHERE id = \$4/, 'keyed on id alone so the true outcome always wins');
});

test('the grace window defaults to 60 minutes and is env-overridable', () => {
  assert.equal(DEFAULT_STRANDED_RUN_GRACE_MINUTES, 60);
  assert.equal(strandedRunGraceMinutes({}), 60, 'unset → default');
  assert.equal(
    strandedRunGraceMinutes({ ARIES_INSIGHTS_SWEEP_GRACE_MINUTES: '  ' }),
    60,
    'blank → default',
  );
  assert.equal(
    strandedRunGraceMinutes({ ARIES_INSIGHTS_SWEEP_GRACE_MINUTES: '240' }),
    240,
    'a valid override widens the window (e.g. before a long backfill ships)',
  );
  // Invalid values fall back rather than producing a zero/negative window
  // that would sweep genuinely in-flight runs.
  for (const bad of ['0', '-5', 'abc', '1.5', 'Infinity']) {
    assert.equal(
      strandedRunGraceMinutes({ ARIES_INSIGHTS_SWEEP_GRACE_MINUTES: bad }),
      60,
      `'${bad}' falls back to the default`,
    );
  }
});

test('a null rowCount (driver quirk) is reported as zero swept', async () => {
  const { pool } = makeRecordingPool({ sweptCount: null });
  assert.equal(await sweepAbandonedSyncRuns(pool), 0);
});

test('the sweep client is released even when the UPDATE throws', async () => {
  const { pool, releaseCalls } = makeRecordingPool({ failSweep: true });
  await assert.rejects(() => sweepAbandonedSyncRuns(pool));
  assert.equal(releaseCalls(), 1, 'no leaked client on a failed sweep');
});

test('every tick runs the sweep before fanning out tenant syncs', async () => {
  const { pool, queries } = makeRecordingPool({
    sweptCount: 1,
    tenantRows: [{ tenant_id: 7 }],
  });
  const syncedTenants: number[] = [];
  const recordingSync: SyncAllAccountsFn = async (tenantId) => {
    syncedTenants.push(tenantId);
    return [];
  };

  await tickSafe(pool, recordingSync);

  assert.equal(queries.length, 2, 'one sweep statement plus one tenant-list query');
  assert.match(queries[0].sql, /UPDATE insights_sync_runs/, 'the sweep runs first');
  assert.match(queries[1].sql, /SELECT DISTINCT tenant_id/, 'then the tenant list loads');
  assert.deepEqual(syncedTenants, [7], 'the tick still syncs after sweeping');
});

test('a sweep failure must not cost tenants their sync window', async () => {
  const { pool, queries } = makeRecordingPool({
    failSweep: true,
    tenantRows: [{ tenant_id: 4 }],
  });
  const syncedTenants: number[] = [];
  const recordingSync: SyncAllAccountsFn = async (tenantId) => {
    syncedTenants.push(tenantId);
    return [];
  };

  await tickSafe(pool, recordingSync);
  assert.deepEqual(
    syncedTenants,
    [4],
    'the tenant fan-out proceeds even when the sweep statement throws',
  );

  // And the overlap guard is released, so the next interval ticks again.
  await tickSafe(pool, recordingSync);
  assert.deepEqual(syncedTenants, [4, 4], 'a failed sweep never wedges the tick guard');
  assert.equal(
    queries.filter((q) => /UPDATE insights_sync_runs/.test(q.sql)).length,
    2,
    'each tick retries the sweep',
  );
});

test('a sweep whose connect() fails is isolated from the tenant fan-out', async () => {
  // First connect (sweep) refused, later connects succeed — e.g. Postgres
  // becomes reachable between the two acquisitions.
  let connects = 0;
  const pool: TickPool = {
    connect: async () => {
      connects++;
      if (connects === 1) {
        throw Object.assign(new Error('connect ECONNREFUSED 172.18.0.11:5432'), {
          code: 'ECONNREFUSED',
        });
      }
      return {
        query: async () => ({ rows: [{ tenant_id: 9 }] }),
        release: () => {},
      };
    },
  };
  const syncedTenants: number[] = [];
  const recordingSync: SyncAllAccountsFn = async (tenantId) => {
    syncedTenants.push(tenantId);
    return [];
  };

  await tickSafe(pool, recordingSync);
  assert.equal(connects, 2, 'the tick still acquires a client for the tenant list');
  assert.deepEqual(syncedTenants, [9], 'tenants sync despite the sweep connect failure');
});

// ── Log-event contract ────────────────────────────────────────────────────────
// The worker's only observable surface in prod is its newline-delimited JSON
// log stream; aggregators key on the `event` field. Capture console.log and
// assert the sweep branches emit (or stay silent on) the right events.

/** Runs fn with console.log captured; returns the parsed JSON log events. */
async function captureLogEvents(
  t: TestContext,
  fn: () => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line?: unknown) => {
    lines.push(String(line));
  });
  await fn();
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('a positive sweep logs insights_sync_stranded_runs_swept with the count', async (t) => {
  const { pool } = makeRecordingPool({ sweptCount: 2 });

  const events = await captureLogEvents(t, () => tickSafe(pool, noopSync));

  const swept = events.filter((e) => e['event'] === 'insights_sync_stranded_runs_swept');
  assert.equal(swept.length, 1, 'exactly one swept event per tick');
  assert.equal(swept[0]?.['count'], 2, 'the event carries the number of rows failed out');
});

test('a clean sweep (zero rows) emits no stranded-runs event', async (t) => {
  const { pool } = makeRecordingPool({ sweptCount: 0 });

  const events = await captureLogEvents(t, () => tickSafe(pool, noopSync));

  assert.equal(
    events.filter((e) => e['event'] === 'insights_sync_stranded_runs_swept').length,
    0,
    'the steady state stays silent — no log noise every 30 minutes',
  );
});

test('a failed sweep logs insights_sync_sweep_failed, never insights_sync_fatal', async (t) => {
  const { pool } = makeRecordingPool({ failSweep: true, tenantRows: [{ tenant_id: 4 }] });

  const events = await captureLogEvents(t, () => tickSafe(pool, noopSync));

  const failed = events.filter((e) => e['event'] === 'insights_sync_sweep_failed');
  assert.equal(failed.length, 1, 'the sweep failure is reported');
  assert.match(
    String(failed[0]?.['error']),
    /insights_sync_runs/,
    'the event carries the underlying error for debugging',
  );
  assert.equal(
    events.filter((e) => e['event'] === 'insights_sync_fatal').length,
    0,
    'a sweep failure is contained — it must not surface as a fatal tick',
  );
});
