import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  DEFAULT_SYNC_FAILURE_ALERT_THRESHOLD,
  SYNC_ALERT_RUNS_SQL,
  defaultDedupeDeps,
  isSyncFailureAlertEnabled,
  runSyncFailureAlertSweep,
  selectAlertCandidates,
  syncAlertDedupKey,
  syncFailureAlertThreshold,
  type SyncAlertCandidate,
} from '../backend/insights/sync-alerts/sync-failure-alerts';
import { buildSyncFailureMessage } from '../backend/insights/sync-alerts/notify-sync-failure';
import {
  RESTART_ABORT_MESSAGE,
  currentFailureEpisode,
  type SyncRunRow,
} from '../backend/insights/sync-health/sync-health-logic';

/**
 * S6-4 / AA-117 (gap F4b) — Slack alert on N consecutive failed sync runs.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-sync-failure-alerts.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

let seq = 0;
function row(partial: Partial<SyncRunRow & { tenantId: number }> = {}): SyncRunRow & {
  tenantId: number;
} {
  seq += 1;
  return {
    tenantId: 7,
    id: 1000 - seq, // descending, so newest-first ordering is natural
    platform: 'instagram',
    trigger: 'interval',
    startedAt: '2026-08-05T10:00:00.000Z',
    finishedAt: '2026-08-05T10:01:00.000Z',
    status: 'failed',
    postsSeen: 0,
    commentsSeen: 0,
    apiUnitsUsed: 0,
    errorMessage: 'OAuthException: token expired',
    ...partial,
  };
}

const ON = { ARIES_SYNC_FAILURE_ALERT_ENABLED: '1' };

// ── The architecture requirement ─────────────────────────────────────────────

test('ARCHITECTURE: the alert worker is spawned by the APP runtime, not the sync worker', () => {
  // The card's required design. The insights-sync worker has no SLACK_*, no
  // OAUTH_TOKEN_ENCRYPTION_KEY and no APP_BASE_URL, and the notify path is
  // fail-open — so a worker-side send would resolve no config, skip, and report
  // success. The alert would never fire and nothing would look broken.
  const runtime = readFileSync(path.join(PROJECT_ROOT, 'scripts', 'start-runtime.mjs'), 'utf8');
  assert.match(runtime, /spawnSyncFailureAlertWorker\(\)/);
  assert.match(runtime, /insights-sync-alert-worker\.ts/);
  assert.match(runtime, /stopSyncFailureAlertWorker\(\)/, 'it must stop on shutdown too');
});

test('ARCHITECTURE: the sync worker service still has no Slack env', () => {
  // If this ever changes, the "must fire from the app" reasoning needs revisiting
  // rather than silently rotting.
  const compose = readFileSync(path.join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8');
  const start = compose.indexOf('aries-insights-sync-worker:');
  assert.ok(start > 0, 'sync worker service should exist');
  const block = compose.slice(start, compose.indexOf('\n  aries-', start + 10));
  for (const forbidden of ['SLACK_BOT_TOKEN', 'ARIES_SLACK_NOTIFICATIONS_ENABLED', 'OAUTH_TOKEN_ENCRYPTION_KEY']) {
    assert.ok(!block.includes(forbidden), `${forbidden} must stay off the sync worker`);
  }
});

test('the alert flag is opt-in — a pager must never start by accident', () => {
  assert.equal(isSyncFailureAlertEnabled({}), false);
  assert.equal(isSyncFailureAlertEnabled({ ARIES_SYNC_FAILURE_ALERT_ENABLED: '0' }), false);
  for (const on of ['1', 'true', 'yes', 'on']) {
    assert.equal(isSyncFailureAlertEnabled({ ARIES_SYNC_FAILURE_ALERT_ENABLED: on }), true, on);
  }
  const runtime = readFileSync(path.join(PROJECT_ROOT, 'scripts', 'start-runtime.mjs'), 'utf8');
  assert.match(runtime, /ARIES_SYNC_FAILURE_ALERT_ENABLED[\s\S]{0,120}defaultWhenUnset: false/);
});

test('the threshold falls back on any unusable value', () => {
  assert.equal(syncFailureAlertThreshold({}), DEFAULT_SYNC_FAILURE_ALERT_THRESHOLD);
  assert.equal(syncFailureAlertThreshold({ ARIES_SYNC_FAILURE_ALERT_THRESHOLD: '5' }), 5);
  for (const bad of ['0', '-2', '2.5', 'three', '1e2', '']) {
    assert.equal(
      syncFailureAlertThreshold({ ARIES_SYNC_FAILURE_ALERT_THRESHOLD: bad }),
      DEFAULT_SYNC_FAILURE_ALERT_THRESHOLD,
      bad,
    );
  }
});

// ── Deploys must not page ────────────────────────────────────────────────────

test('a run of restart-aborts never reaches the threshold', () => {
  const runs = [
    row({ errorMessage: RESTART_ABORT_MESSAGE }),
    row({ errorMessage: RESTART_ABORT_MESSAGE }),
    row({ errorMessage: RESTART_ABORT_MESSAGE }),
    row({ errorMessage: RESTART_ABORT_MESSAGE }),
  ];
  assert.deepEqual(selectAlertCandidates(runs, 3), [], 'a deploy must not page anyone');
});

test('a deploy in the middle of a real outage does not hide it', () => {
  const runs = [row(), row({ errorMessage: RESTART_ABORT_MESSAGE }), row(), row()];
  const candidates = selectAlertCandidates(runs, 3);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].streak, 3, 'the restart is skipped, not counted as a reset');
});

test('a success anywhere in the window stops the alert', () => {
  const runs = [row(), row({ status: 'ok', errorMessage: null }), row(), row()];
  assert.deepEqual(selectAlertCandidates(runs, 3), []);
});

test('classifies the newest failed non-restart row in the current episode', () => {
  const candidates = selectAlertCandidates([
    row({ status: 'running', errorMessage: null }),
    row({ errorMessage: RESTART_ABORT_MESSAGE }),
    row({ errorMessage: 'OAuthException: token expired' }),
    row({ errorMessage: 'OAuthException: token expired' }),
    row({ errorMessage: 'OAuthException: token expired' }),
  ], 3);
  assert.equal(candidates[0]?.failureCategory, 'auth');
});

// ── Threshold + grouping ─────────────────────────────────────────────────────

test('fires at exactly N, not N-1', () => {
  assert.equal(selectAlertCandidates([row(), row()], 3).length, 0);
  assert.equal(selectAlertCandidates([row(), row(), row()], 3).length, 1);
});

test('each (tenant, platform) is judged independently', () => {
  const runs = [
    row({ tenantId: 7, platform: 'instagram' }),
    row({ tenantId: 7, platform: 'instagram' }),
    row({ tenantId: 7, platform: 'instagram' }),
    row({ tenantId: 7, platform: 'facebook' }),
    row({ tenantId: 9, platform: 'instagram' }),
    row({ tenantId: 9, platform: 'instagram' }),
    row({ tenantId: 9, platform: 'instagram' }),
  ];
  const candidates = selectAlertCandidates(runs, 3);
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((c) => `${c.tenantId}:${c.platform}`),
    ['7:instagram', '9:instagram'],
    'facebook has only one failure and must not alert',
  );
});

// ── Dedupe keying ────────────────────────────────────────────────────────────

test('the dedupe key identifies the OUTAGE, not the tenant or the latest run', () => {
  // Keyed on the tenant alone it would page once ever. Keyed on the newest run
  // it would page on every tick, because each tick appends a run.
  const first = row();
  const runs = [row(), row(), first];
  const episode = currentFailureEpisode(runs);
  assert.equal(episode.firstFailedRunId, first.id, 'the key anchors on the episode start');

  const before = selectAlertCandidates(runs, 3)[0];
  // Another tick adds a newer failure — same outage, so the key must not move.
  const after = selectAlertCandidates([row(), ...runs], 3)[0];
  assert.equal(after.dedupKey, before.dedupKey, 'an ongoing outage must not re-page');
  assert.equal(after.streak, 4);
});

test('a long outage above the old 20-run window keeps one episode identity', () => {
  const outage = Array.from({ length: 30 }, (_, index) => row({ id: 130 - index }));
  const before = selectAlertCandidates(outage, 25)[0];
  const after = selectAlertCandidates([row({ id: 131 }), ...outage], 25)[0];
  assert.equal(before?.streak, 30);
  assert.equal(after?.streak, 31);
  assert.equal(after?.dedupKey, before?.dedupKey);
});

test('a NEW outage after a recovery gets a new key, so it pages again', () => {
  const oldEpisodeStart = row();
  const firstOutage = [row(), row(), oldEpisodeStart];
  const keyA = selectAlertCandidates(firstOutage, 3)[0].dedupKey;

  const newEpisodeStart = row();
  const recovered = [
    row(),
    row(),
    newEpisodeStart,
    row({ status: 'ok', errorMessage: null }),
    ...firstOutage,
  ];
  const keyB = selectAlertCandidates(recovered, 3)[0].dedupKey;

  assert.notEqual(keyA, keyB, 'a second outage must be able to page');
});

test('the dedupe key is stable and namespaced', () => {
  assert.equal(syncAlertDedupKey(7, 'instagram', 42), 'sync-failure:7:instagram:42');
});

// ── Sweep ────────────────────────────────────────────────────────────────────

function sweepDeps(rows: Record<string, unknown>[], sent: Set<string>) {
  const posted: SyncAlertCandidate[] = [];
  const recorded: string[] = [];
  return {
    posted,
    recorded,
    deps: {
      db: { async query(_sql: string, params: unknown[] = []) { return { rows: episodeDbRows(rows, Number(params[0])) as never[] }; } },
      send: async (c: SyncAlertCandidate) => {
        posted.push(c);
        return true;
      },
      alreadySent: async (key: string) => sent.has(key),
      recordSent: async (c: SyncAlertCandidate) => {
        recorded.push(c.dedupKey);
      },
      env: ON,
    },
  };
}

function dbRow(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    tenant_id: 7,
    id: 1000 - seq,
    platform: 'instagram',
    status: 'failed',
    error_message: 'token expired',
    started_at: '2026-08-05T10:00:00.000Z',
    finished_at: '2026-08-05T10:01:00.000Z',
    ...overrides,
  };
}

function episodeDbRows(rows: Record<string, unknown>[], threshold = 3) {
  const runs = rows.map((row) => ({
    tenantId: Number(row.tenant_id),
    id: Number(row.id),
    platform: String(row.platform),
    trigger: 'interval',
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    status: String(row.status) as 'running' | 'ok' | 'partial' | 'failed',
    postsSeen: 0,
    commentsSeen: 0,
    apiUnitsUsed: 0,
    errorMessage: (row.error_message as string | null) ?? null,
  }));
  return selectAlertCandidates(runs, threshold).map((candidate) => ({
    tenant_id: candidate.tenantId,
    platform: candidate.platform,
    streak: candidate.streak,
    first_failed_run_id: candidate.firstFailedRunId,
    latest_error_message: runs.find(
      (run) => run.tenantId === candidate.tenantId
        && run.platform === candidate.platform
        && run.status === 'failed'
        && run.errorMessage !== RESTART_ABORT_MESSAGE,
    )?.errorMessage ?? null,
  }));
}

test('a 3-failure streak posts exactly once and records the dedupe row', async () => {
  const { deps, posted, recorded } = sweepDeps([dbRow(), dbRow(), dbRow()], new Set());
  const report = await runSyncFailureAlertSweep(deps);
  assert.equal(report.candidates, 1);
  assert.equal(report.sent, 1);
  assert.equal(posted.length, 1, 'exactly once');
  assert.equal(recorded.length, 1);
});

test('two concurrent sweeps cannot both deliver the same outage', async () => {
  const rows = [dbRow(), dbRow(), dbRow()];
  const recorded = new Set<string>();
  let advisoryLocked = false;
  let posted = 0;

  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('pg_try_advisory_lock')) {
      if (advisoryLocked) return { rows: [{ locked: false }], rowCount: 1 };
      advisoryLocked = true;
      return { rows: [{ locked: true }], rowCount: 1 };
    }
    if (sql.includes('pg_advisory_unlock')) {
      advisoryLocked = false;
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }
    if (sql.includes('SELECT 1 FROM slack_notifications')) {
      const exists = recorded.has(String(params[0]));
      return { rows: exists ? [{ found: 1 }] : [], rowCount: exists ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO slack_notifications')) {
      recorded.add(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const fakePool = {
    query,
    connect: async () => ({ query, release() {} }),
  };
  const deps = {
    db: { async query() { return { rows: episodeDbRows(rows) as never[] }; } },
    send: async () => {
      posted += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    },
    ...defaultDedupeDeps(fakePool as never),
    env: ON,
  };

  await Promise.all([
    runSyncFailureAlertSweep(deps),
    runSyncFailureAlertSweep(deps),
  ]);

  assert.equal(posted, 1);
  assert.equal(recorded.size, 1);
});

test('an already-alerted outage is deduped, not re-posted', async () => {
  const rows = [dbRow(), dbRow(), dbRow()];
  const { deps: probe } = sweepDeps(rows, new Set());
  const key = (await runSyncFailureAlertSweep(probe), selectAlertCandidates(
    rows.map((r) => ({
      tenantId: Number(r.tenant_id),
      id: Number(r.id),
      platform: String(r.platform),
      trigger: 'interval',
      startedAt: String(r.started_at),
      finishedAt: String(r.finished_at),
      status: 'failed' as const,
      postsSeen: 0,
      commentsSeen: 0,
      apiUnitsUsed: 0,
      errorMessage: String(r.error_message),
    })),
    3,
  )[0].dedupKey);

  const { deps, posted } = sweepDeps(rows, new Set([key]));
  const report = await runSyncFailureAlertSweep(deps);
  assert.equal(report.deduped, 1);
  assert.equal(report.sent, 0);
  assert.equal(posted.length, 0);
});

test('with the flag OFF the sweep does no work at all', async () => {
  let queried = false;
  const report = await runSyncFailureAlertSweep({
    db: { async query() { queried = true; return { rows: [] as never[] }; } },
    send: async () => true,
    alreadySent: async () => false,
    recordSent: async () => {},
    env: {},
  });
  assert.equal(queried, false, 'the disabled path must not touch the database');
  assert.deepEqual(report, { scanned: 0, candidates: 0, sent: 0, deduped: 0, failed: 0 });
});

test('a failed send leaves NO dedupe row, so the next tick retries', async () => {
  const recorded: string[] = [];
  const rows = [dbRow(), dbRow(), dbRow()];
  const report = await runSyncFailureAlertSweep({
    db: { async query() { return { rows: episodeDbRows(rows) as never[] }; } },
    send: async () => false,
    alreadySent: async () => false,
    recordSent: async (c) => { recorded.push(c.dedupKey); },
    env: ON,
  });
  assert.equal(report.failed, 1);
  assert.equal(report.sent, 0);
  assert.equal(recorded.length, 0, 'never mark an alert delivered that nobody received');
});

test('one tenant failing does not suppress another tenant\'s alert', async () => {
  const rows = [
    dbRow({ tenant_id: 7 }), dbRow({ tenant_id: 7 }), dbRow({ tenant_id: 7 }),
    dbRow({ tenant_id: 9 }), dbRow({ tenant_id: 9 }), dbRow({ tenant_id: 9 }),
  ];
  const posted: number[] = [];
  const report = await runSyncFailureAlertSweep({
    db: { async query() { return { rows: episodeDbRows(rows) as never[] }; } },
    send: async (c) => {
      if (c.tenantId === 7) throw new Error('tenant 7 slack is broken');
      posted.push(c.tenantId);
      return true;
    },
    alreadySent: async () => false,
    recordSent: async () => {},
    env: ON,
  });
  assert.equal(report.failed, 1);
  assert.equal(report.sent, 1);
  assert.deepEqual(posted, [9]);
});

test('a scan failure degrades to no alerts rather than throwing', async () => {
  const report = await runSyncFailureAlertSweep({
    db: { async query() { throw new Error('db down'); } },
    send: async () => true,
    alreadySent: async () => false,
    recordSent: async () => {},
    env: ON,
  });
  assert.deepEqual(report, { scanned: 0, candidates: 0, sent: 0, deduped: 0, failed: 0 });
});

test('a configured threshold above 20 is passed to the episode query', async () => {
  const values: unknown[][] = [];
  await runSyncFailureAlertSweep({
    db: { async query(_sql, params = []) { values.push(params); return { rows: [] as never[] }; } },
    send: async () => true,
    alreadySent: async () => false,
    recordSent: async () => {},
    env: { ...ON, ARIES_SYNC_FAILURE_ALERT_THRESHOLD: '25' },
  });
  assert.equal(values[0]?.[0], 25);
});

// ── Query + message ──────────────────────────────────────────────────────────

test('the episode query keeps a stable start beyond any recent-run window', () => {
  assert.match(SYNC_ALERT_RUNS_SQL, /PARTITION BY (?:r\.)?tenant_id, (?:r\.)?platform/);
  assert.match(SYNC_ALERT_RUNS_SQL, /first_failed_run_id/);
  assert.match(SYNC_ALERT_RUNS_SQL, /HAVING COUNT\(\*\) >= \$1/);
  assert.doesNotMatch(SYNC_ALERT_RUNS_SQL, /7 days|rn <=|LIMIT 20/);
});

test('the message states the real streak and links to Insights', () => {
  const msg = buildSyncFailureMessage(
    {
      tenantId: 7,
      platform: 'instagram',
      streak: 4,
      firstFailedRunId: 1,
      failureCategory: 'auth',
      dedupKey: 'k',
    },
    'https://aries.example.com/',
  );
  assert.match(msg.text, /Instagram analytics sync has failed 4 times in a row/);
  assert.match(msg.text, /reauthorizing/, 'an auth failure tells them what to do');
  assert.match(msg.text, /https:\/\/aries\.example\.com\/insights/);
  assert.doesNotMatch(msg.text, /\/\/insights/, 'no double slash from a trailing-slash base url');
});

test('the alert resolves the tenant OWN Slack workspace, never a global channel', () => {
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'insights', 'sync-alerts', 'notify-sync-failure.ts'),
    'utf8',
  );
  assert.match(source, /loadSlackConfigForTenant/);
  // A global fallback would disclose one tenant's outage in another's channel.
  assert.doesNotMatch(source, /SLACK_SINGLE_TENANT_CHANNEL/);
  assert.match(source, /if \(!cfg\) \{/, 'no config ⇒ skip cleanly');
});
