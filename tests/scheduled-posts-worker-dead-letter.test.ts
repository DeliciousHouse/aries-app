import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs');

type FailureResult = { kind?: string; error?: string; retryable?: boolean };
type WorkerModule = {
  classifyDispatchFailure: (result: FailureResult) => string;
  resolveDispatchFailurePolicy: (
    result: FailureResult,
    env?: Record<string, string>,
  ) => { failureClass: string; terminal: boolean; backoffMinutes: number | null; maxAttempts: number };
  planPlatformOutcomes: (
    platforms: string[],
    results: Array<{ provider: string; ok: boolean; error?: string; retryable?: boolean; kind?: string }>,
    transportError: string | null,
  ) => Array<{ status: string; failureClass: string | null }>;
  applyTransientRetryLimit: (
    outcomes: Array<{ platform: string; status: string; failureClass: string | null }>,
    priorAttempts: Map<string, number>,
    maxAttempts: number,
  ) => Array<{ status: string; failureClass: string | null }>;
  rollupParentStatus: (statuses: string[]) => string;
};

async function loadWorker(): Promise<WorkerModule> {
  return await import(pathToFileURL(workerPath).href) as unknown as WorkerModule;
}

test('dispatch taxonomy routes auth, transient, permanent, and invalid media', async () => {
  const { classifyDispatchFailure } = await loadWorker();
  assert.equal(classifyDispatchFailure({ kind: 'auth', error: 'oauth_token_missing' }), 'auth_token');
  assert.equal(classifyDispatchFailure({ kind: 'transient', error: 'rate_limited', retryable: true }), 'platform_transient');
  assert.equal(classifyDispatchFailure({ kind: 'permanent', error: 'unsupported_provider', retryable: false }), 'platform_permanent');
  assert.equal(classifyDispatchFailure({ kind: 'permanent', error: 'media_invalid: wrong aspect ratio', retryable: false }), 'media_invalid');
  assert.equal(classifyDispatchFailure({ kind: 'validation', error: 'invalid media' }), 'media_invalid');
});

test('dispatch policy retries only transient failures and dead-letters terminal classes', async () => {
  const { resolveDispatchFailurePolicy, planPlatformOutcomes } = await loadWorker();
  const env = {
    ARIES_DISPATCH_RETRY_BACKOFF_MINUTES: '12',
    ARIES_DISPATCH_RATE_LIMIT_BACKOFF_MINUTES: '240',
    ARIES_DISPATCH_TRANSIENT_MAX_ATTEMPTS: '4',
  };
  assert.deepEqual(
    resolveDispatchFailurePolicy({ kind: 'transient', error: 'rate_limited', retryable: true }, env),
    { failureClass: 'platform_transient', terminal: false, backoffMinutes: 240, maxAttempts: 4 },
  );
  for (const result of [
    { kind: 'auth', error: 'oauth_token_missing', retryable: false },
    { kind: 'permanent', error: 'unsupported_provider', retryable: false },
    { kind: 'permanent', error: 'bad_media: invalid image', retryable: false },
  ]) {
    const policy = resolveDispatchFailurePolicy(result, env);
    assert.equal(policy.terminal, true);
    assert.equal(policy.backoffMinutes, null);
  }

  const outcomes = planPlatformOutcomes(
    ['facebook', 'instagram'],
    [
      { provider: 'facebook', ok: false, kind: 'auth', error: 'oauth_token_missing', retryable: false },
      { provider: 'instagram', ok: false, kind: 'transient', error: 'gateway timeout', retryable: true },
    ],
    null,
  );
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['dead_letter', 'pending']);
  assert.deepEqual(outcomes.map((outcome) => outcome.failureClass), ['auth_token', 'platform_transient']);
});

test('dead-letter is a terminal parent rollup state', async () => {
  const { applyTransientRetryLimit, rollupParentStatus } = await loadWorker();
  assert.equal(rollupParentStatus(['dispatched', 'dead_letter']), 'dead_letter');
  assert.equal(rollupParentStatus(['dead_letter', 'dead_letter']), 'dead_letter');
  assert.equal(rollupParentStatus(['dead_letter', 'pending']), 'pending', 'retryable siblings finish first');
  const exhausted = applyTransientRetryLimit(
    [{ platform: 'instagram', status: 'pending', failureClass: 'platform_transient' }],
    new Map([['instagram', 3]]),
    4,
  );
  assert.equal(exhausted[0]?.status, 'dead_letter', 'the fourth transient failure exhausts a four-attempt policy');
});

test('schema migration persists attempts, failure class, and dead-letter state', () => {
  const migration = path.join(REPO_ROOT, 'migrations/20260806000000_scheduled_dispatch_dead_letters.sql');
  assert.ok(existsSync(migration), 'dead-letter migration must exist');
  const source = readFileSync(migration, 'utf8');
  assert.match(source, /failure_class TEXT/);
  assert.match(source, /attempts INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /dead_lettered_at TIMESTAMPTZ/);
  assert.match(source, /dead_letter/);

  const initDb = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');
  assert.match(initDb, /status IN \('pending','in_flight','dispatched','failed','dead_letter','manual_reconciliation'\)/);
  assert.match(initDb, /dispatch_status IN \('pending','in_flight','dispatched','failed','dead_letter','manual_reconciliation'\)/);

  const alertRules = readFileSync(
    path.join(REPO_ROOT, 'ops/alerts/aries-content-pipeline.rules.yml'),
    'utf8',
  );
  assert.match(alertRules, /alert: AriesDispatchDeadLetters/);
  assert.match(alertRules, /aries_dispatch_dead_letters_total/);
  assert.match(alertRules, /alert: AriesDraftsExpiringSoon/);
  assert.match(alertRules, /aries_drafts_expiring_24h/);
});
