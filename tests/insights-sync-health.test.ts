import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  RESTART_ABORT_MESSAGE,
  classifySyncFailure,
  consecutiveFailureStreak,
  isRestartAbort,
  summarizeByPlatform,
  type SyncRunRow,
} from '../backend/insights/sync-health/sync-health-logic';
import {
  MAX_SYNC_HEALTH_RUNS,
  SYNC_HEALTH_RUNS_SQL,
  handleGetInsightsSyncHealth,
  loadSyncRuns,
  type SyncHealthQueryable,
} from '../backend/insights/sync-health/handler';
import type { TenantContext } from '../lib/tenant-context';
import type { TenantContextLoader } from '../lib/tenant-context-http';
import { SWEEP_STRANDED_SYNC_RUNS_SQL } from '../backend/insights/sync/sweep-stranded-runs';

/**
 * S6-3 / AA-116 (gap F4a) — sync-health read model over insights_sync_runs.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-sync-health.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const URL_BASE = 'https://aries.example.com/api/insights/sync-health';

let nextId = 100;
function run(partial: Partial<SyncRunRow> = {}): SyncRunRow {
  return {
    id: (nextId += 1),
    platform: 'instagram',
    trigger: 'interval',
    startedAt: '2026-08-05T10:00:00.000Z',
    finishedAt: '2026-08-05T10:01:00.000Z',
    status: 'ok',
    postsSeen: 3,
    commentsSeen: 1,
    apiUnitsUsed: 5,
    errorMessage: null,
    ...partial,
  };
}

const failed = (msg = 'Graph API error 190') => run({ status: 'failed', errorMessage: msg });
const restartAbort = () => run({ status: 'failed', errorMessage: RESTART_ABORT_MESSAGE });

// ── The restart-abort distinction (load-bearing for AA-117) ──────────────────

test('the restart-abort marker matches what the sweep actually writes', () => {
  // If these drift, every deploy starts paging — the sweep stamps this exact
  // string and the streak logic keys off it.
  assert.ok(
    SWEEP_STRANDED_SYNC_RUNS_SQL.includes(`'${RESTART_ABORT_MESSAGE}'`),
    'RESTART_ABORT_MESSAGE must equal the sweep SQL literal',
  );
});

test('isRestartAbort is exact, not a substring guess', () => {
  assert.equal(isRestartAbort({ errorMessage: RESTART_ABORT_MESSAGE }), true);
  assert.equal(isRestartAbort({ errorMessage: '  Aborted By Worker Restart ' }), true);
  assert.equal(isRestartAbort({ errorMessage: null }), false);
  assert.equal(
    isRestartAbort({ errorMessage: 'connection aborted by worker restart handler failure' }),
    false,
    'a longer message that merely contains the phrase is a real failure',
  );
});

// ── Streak ───────────────────────────────────────────────────────────────────

test('counts consecutive failures from the newest run', () => {
  assert.equal(consecutiveFailureStreak([failed(), failed(), failed()]), 3);
  assert.equal(consecutiveFailureStreak([failed(), failed(), run()]), 2);
  assert.equal(consecutiveFailureStreak([]), 0);
});

test('a success BREAKS the streak, including a partial', () => {
  assert.equal(consecutiveFailureStreak([run({ status: 'ok' }), failed(), failed()]), 0);
  assert.equal(
    consecutiveFailureStreak([run({ status: 'partial' }), failed(), failed()]),
    0,
    'a partial run persisted data — degraded success, not failure',
  );
});

test('restart-aborts are skipped entirely so deploys never page', () => {
  // The whole point: every deploy restarts the worker and fails out in-flight
  // runs. Counting them would make the alert fire on every release.
  assert.equal(consecutiveFailureStreak([restartAbort(), restartAbort(), restartAbort()]), 0);

  // And a deploy in the MIDDLE of a real outage must not reset the count and
  // hide it.
  assert.equal(consecutiveFailureStreak([failed(), restartAbort(), failed()]), 2);
});

test('an in-flight run is skipped, not counted as either outcome', () => {
  assert.equal(consecutiveFailureStreak([run({ status: 'running' }), failed(), failed()]), 2);
});

// ── Failure classification ───────────────────────────────────────────────────

test('classifies failures into actionable categories', () => {
  assert.equal(classifySyncFailure(RESTART_ABORT_MESSAGE), 'restart_abort');
  assert.equal(classifySyncFailure('OAuthException: token expired'), 'auth');
  assert.equal(classifySyncFailure('HTTP 401 Unauthorized'), 'auth');
  assert.equal(classifySyncFailure('Rate limit reached, try again later'), 'rate_limit');
  assert.equal(classifySyncFailure('429 too many requests'), 'rate_limit');
  assert.equal(classifySyncFailure('not_configured'), 'not_configured');
  assert.equal(classifySyncFailure('kaboom'), 'other');
  assert.equal(classifySyncFailure(null), 'other');
  assert.equal(classifySyncFailure('   '), 'other');
});

// ── Per-platform rollup ──────────────────────────────────────────────────────

test('summarizes each platform independently', () => {
  const rows = [
    run({ platform: 'facebook', status: 'failed', errorMessage: 'token expired' }),
    run({ platform: 'facebook', status: 'failed', errorMessage: 'token expired' }),
    run({ platform: 'instagram', status: 'ok', finishedAt: '2026-08-05T09:00:00.000Z' }),
  ];
  const summary = summarizeByPlatform(rows);
  const fb = summary.find((s) => s.platform === 'facebook')!;
  const ig = summary.find((s) => s.platform === 'instagram')!;

  assert.equal(fb.consecutiveFailures, 2);
  assert.equal(fb.failureCategory, 'auth');
  assert.equal(fb.lastSuccessAt, null, 'facebook has no success in the window');

  assert.equal(ig.consecutiveFailures, 0);
  assert.equal(ig.failureCategory, null, 'a healthy platform reports no category');
  assert.equal(ig.lastSuccessAt, '2026-08-05T09:00:00.000Z');
});

// ── Query ────────────────────────────────────────────────────────────────────

test('the runs query is tenant-scoped, parameterized and newest-first', () => {
  assert.match(SYNC_HEALTH_RUNS_SQL, /r\.tenant_id = \$1/);
  assert.match(SYNC_HEALTH_RUNS_SQL, /LIMIT \$3/);
  assert.match(SYNC_HEALTH_RUNS_SQL, /ORDER BY COALESCE\(r\.finished_at, r\.started_at\) DESC/);
});

test('the row cap is enforced however large a limit is asked for', async () => {
  const seen: unknown[][] = [];
  const db: SyncHealthQueryable = {
    async query(_t: string, v?: unknown[]) {
      seen.push(v ?? []);
      return { rows: [] as never[] };
    },
  };
  await loadSyncRuns(db, 7, null, 10_000);
  assert.deepEqual(seen[0], [7, null, MAX_SYNC_HEALTH_RUNS]);

  await loadSyncRuns(db, 7, 'facebook', 5);
  assert.deepEqual(seen[1], [7, 'facebook', 5]);
});

// ── Route + the role boundary ────────────────────────────────────────────────

function loader(role: string, tenantId = '7'): TenantContextLoader {
  return async () =>
    ({ tenantId, tenantSlug: 't', userId: 'u', role }) as unknown as TenantContext;
}

test('unauthenticated sync-health is refused', async () => {
  const res = await handleGetInsightsSyncHealth(new Request(URL_BASE), async () => {
    throw new Error('Authentication required.');
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'tenant_context_required');
});

test('a non-numeric tenant is refused rather than coerced', async () => {
  const res = await handleGetInsightsSyncHealth(new Request(URL_BASE), loader('tenant_admin', 'nope'));
  assert.equal(res.status, 403);
});

test('the response is never cached', () => {
  // A cached health view would report a sync as broken after it recovered.
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'insights', 'sync-health', 'handler.ts'),
    'utf8',
  );
  assert.match(source, /'Cache-Control': 'no-store'/);
});

test('SECURITY: the raw failure reason is admin-only; other roles get the category', () => {
  // error_message is raw third-party adapter text — provider internals, request
  // ids, sometimes the account identifier. The category is enough for a viewer
  // to act on; the raw string is not theirs to see.
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'insights', 'sync-health', 'handler.ts'),
    'utf8',
  );
  assert.match(source, /role === 'tenant_admin'/);
  assert.match(source, /failureReason: isAdmin \? run\.errorMessage : null/);
  // And the payload says WHY it is null, so the UI can tell "no error" apart
  // from "not visible to you".
  assert.match(source, /canSeeFailureDetail: isAdmin/);
});

test('the route is read-only and reads the tenant only from context', () => {
  const route = readFileSync(
    path.join(PROJECT_ROOT, 'app', 'api', 'insights', 'sync-health', 'route.ts'),
    'utf8',
  );
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);

  const handler = readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'insights', 'sync-health', 'handler.ts'),
    'utf8',
  );
  assert.match(handler, /tenantResult\.tenantContext\.tenantId/);
  assert.doesNotMatch(
    handler,
    /searchParams\.get\(\s*['"](tenant|tenantId|tenant_id|organizationId)['"]\s*\)/i,
  );
  assert.doesNotMatch(handler, /\b(INSERT|UPDATE|DELETE)\b/, 'this table stays write-only elsewhere');
});
