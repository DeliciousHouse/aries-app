import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The worker is a .mjs script with no type declarations, so it cannot be
// imported under the route-type tsc gate. Load it through a dynamic import in
// a child of node:test (the worker only auto-starts when run directly).
type PlatformOutcome = {
  platform: string;
  status: 'pending' | 'in_flight' | 'dispatched' | 'failed';
  error: string | null;
  retryable: boolean;
  platformPostId: string | null;
};
type WorkerModule = {
  rollupParentStatus: (statuses: string[]) => string;
  planPlatformOutcomes: (
    platforms: string[],
    results: Array<{
      provider: string;
      ok: boolean;
      platformPostId?: string;
      error?: string;
      retryable?: boolean;
      kind?: string;
    }>,
    transportError: string | null,
    mediaType?: string,
  ) => PlatformOutcome[];
};

async function loadWorker(): Promise<WorkerModule> {
  return (await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs')).href
  )) as unknown as WorkerModule;
}

test('rollupParentStatus: FB dispatched + IG failed rolls up to failed', async () => {
  const { rollupParentStatus } = await loadWorker();
  assert.equal(rollupParentStatus(['dispatched', 'failed']), 'failed');
  assert.equal(rollupParentStatus(['dispatched', 'dispatched']), 'dispatched');
  assert.equal(rollupParentStatus(['failed', 'failed']), 'failed');
  // A still-pending platform keeps the parent non-terminal so it is re-claimed.
  assert.equal(rollupParentStatus(['dispatched', 'pending']), 'pending');
  assert.equal(rollupParentStatus(['in_flight', 'dispatched']), 'in_flight');
  assert.equal(rollupParentStatus([]), 'pending');
});

test('planPlatformOutcomes: FB ok / IG terminal-fail => FB dispatched, IG failed, FB not retried', async () => {
  const { planPlatformOutcomes, rollupParentStatus } = await loadWorker();
  const outcomes = planPlatformOutcomes(
    ['facebook', 'instagram'],
    [
      { provider: 'facebook', ok: true },
      { provider: 'instagram', ok: false, error: 'media_invalid', retryable: false },
    ],
    null,
  );

  const fb = outcomes.find((o) => o.platform === 'facebook')!;
  const ig = outcomes.find((o) => o.platform === 'instagram')!;

  assert.equal(fb.status, 'dispatched', 'FB child row must be dispatched');
  assert.equal(fb.retryable, false, 'a dispatched FB platform must never be retried');
  assert.equal(ig.status, 'failed', 'IG child row must be failed (terminal)');
  assert.equal(ig.error, 'media_invalid');

  const parent = rollupParentStatus(outcomes.map((o) => o.status));
  assert.equal(parent, 'failed', 'parent rollup must be failed when any platform failed');
});

test('planPlatformOutcomes retains each successful provider post id on its matching child outcome', async () => {
  const { planPlatformOutcomes } = await loadWorker();
  const outcomes = planPlatformOutcomes(
    ['facebook', 'instagram'],
    [
      { provider: 'facebook', ok: true, platformPostId: 'fb_901' },
      { provider: 'instagram', ok: true, platformPostId: 'ig_902' },
    ],
    null,
  );

  assert.deepEqual(
    outcomes.map(({ platform, platformPostId }) => ({ platform, platformPostId })),
    [
      { platform: 'facebook', platformPostId: 'fb_901' },
      { platform: 'instagram', platformPostId: 'ig_902' },
    ],
  );
});

test('legacy aggregate platform id remains first-write-wins across partial retries', () => {
  const routeSource = readFileSync(
    path.join(REPO_ROOT, 'app/api/internal/publishing/scheduled-dispatch/route.ts'),
    'utf8',
  );
  assert.match(
    routeSource,
    /platform_post_id\s*=\s*COALESCE\(platform_post_id,\s*\$2\)/,
    'a later platform retry must not replace the first successful aggregate id',
  );
});

test('planPlatformOutcomes: a retryable IG failure stays pending, not failed', async () => {
  const { planPlatformOutcomes, rollupParentStatus } = await loadWorker();
  const outcomes = planPlatformOutcomes(
    ['facebook', 'instagram'],
    [
      { provider: 'facebook', ok: true, platformPostId: 'fb_partial_901' },
      { provider: 'instagram', ok: false, error: 'rate_limited', retryable: true },
    ],
    null,
  );
  const ig = outcomes.find((o) => o.platform === 'instagram')!;
  const fb = outcomes.find((o) => o.platform === 'facebook')!;
  assert.equal(fb.platformPostId, 'fb_partial_901', 'the successful child retains its id while IG retries');
  assert.equal(ig.platformPostId, null, 'a retryable failure never invents a provider id');
  assert.equal(ig.status, 'pending', 'a retryable failure stays pending for the next pass');
  // FB is dispatched; IG pending -> parent stays non-terminal (re-claimable).
  assert.equal(rollupParentStatus(outcomes.map((o) => o.status)), 'pending');
});

test('planPlatformOutcomes: a transport error leaves every (image) platform pending', async () => {
  const { planPlatformOutcomes } = await loadWorker();
  const outcomes = planPlatformOutcomes(['facebook', 'instagram'], [], 'fetch failed after retry', 'image');
  assert.ok(
    outcomes.every((o) => o.status === 'pending' && o.retryable === true),
    'a whole-call transport failure must not terminally fail any image platform',
  );
});

test('planPlatformOutcomes: a VIDEO transport error is non-retryable (no duplicate Reel)', async () => {
  const { planPlatformOutcomes } = await loadWorker();
  // A transport timeout on a long async video publish = outcome unknown; the
  // route may have published server-side, so auto-retrying duplicates the Reel
  // (the 8x-IG incident). Must NOT stay pending/retryable.
  const outcomes = planPlatformOutcomes(['facebook', 'instagram'], [], 'fetch failed after retry', 'video');
  assert.ok(
    outcomes.every((o) => o.status === 'failed' && o.retryable === false),
    'a video transport failure must be terminal-non-retryable to avoid duplicate Reels',
  );
  assert.match(outcomes[0].error ?? '', /outcome_unknown/);
});

test('worker schema: scheduled_post_dispatches child table exists in init-db.js', () => {
  const initDbSource = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');
  assert.match(
    initDbSource,
    /CREATE TABLE IF NOT EXISTS scheduled_post_dispatches/,
    'init-db.js must declare the scheduled_post_dispatches child table',
  );
  assert.match(
    initDbSource,
    /UNIQUE \(scheduled_post_id, platform\)/,
    'one child row per (scheduled_post, platform)',
  );
  assert.match(
    initDbSource,
    /status IN \('pending','in_flight','dispatched','failed'\)/,
    'child status must allow the four-state lifecycle',
  );
  assert.match(
    initDbSource,
    /ALTER TABLE scheduled_post_dispatches\s+ADD COLUMN IF NOT EXISTS platform_post_id TEXT/,
    'existing init-db users receive the durable per-platform id column',
  );
  assert.match(
    initDbSource,
    /CREATE INDEX IF NOT EXISTS idx_scheduled_post_dispatches_platform_post_id\s+ON scheduled_post_dispatches \(platform_post_id, platform\)\s+WHERE platform_post_id IS NOT NULL/,
    'init-db includes the partial composite lookup index',
  );

  const migrationPath = path.join(
    REPO_ROOT,
    'migrations/20260719000000_scheduled_dispatch_platform_post_id.sql',
  );
  assert.ok(existsSync(migrationPath), 'the durable per-platform id migration must exist');
  const migrationSource = readFileSync(migrationPath, 'utf8');
  assert.match(
    migrationSource,
    /ALTER TABLE scheduled_post_dispatches\s+ADD COLUMN IF NOT EXISTS platform_post_id TEXT/,
    'migration adds the column idempotently',
  );
  assert.match(
    migrationSource,
    /CREATE INDEX IF NOT EXISTS idx_scheduled_post_dispatches_platform_post_id\s+ON scheduled_post_dispatches \(platform_post_id, platform\)\s+WHERE platform_post_id IS NOT NULL/,
    'migration adds the lookup index idempotently',
  );
});


test('planPlatformOutcomes: an auth kind prefixes the error_message with a reconnect signal', async () => {
  const { planPlatformOutcomes } = await loadWorker();
  const outcomes = planPlatformOutcomes(
    ['facebook'],
    [{ provider: 'facebook', ok: false, error: 'oauth_token_missing: token expired', retryable: false, kind: 'auth' }],
    null,
  );
  const fb = outcomes.find((o) => o.platform === 'facebook')!;
  // Retry policy unchanged: auth is terminal (retryable:false -> failed).
  assert.equal(fb.status, 'failed');
  assert.equal(fb.retryable, false);
  // Surface-only: the operator can now see WHY a terminal row failed.
  assert.match(fb.error ?? '', /reconnect required/i, 'auth reason surfaced in error_message');
  assert.match(fb.error ?? '', /oauth_token_missing/, 'original code preserved');
});

test('planPlatformOutcomes: a non-auth kind leaves the error_message untouched', async () => {
  const { planPlatformOutcomes } = await loadWorker();
  const outcomes = planPlatformOutcomes(
    ['facebook', 'instagram'],
    [
      { provider: 'facebook', ok: false, error: 'graph_api_error: 400', retryable: false, kind: 'permanent' },
      { provider: 'instagram', ok: false, error: 'rate_limited', retryable: true, kind: 'transient' },
    ],
    null,
  );
  const fb = outcomes.find((o) => o.platform === 'facebook')!;
  const ig = outcomes.find((o) => o.platform === 'instagram')!;
  assert.equal(fb.error, 'graph_api_error: 400', 'permanent kind: error_message verbatim');
  assert.equal(fb.status, 'failed');
  assert.equal(ig.error, 'rate_limited', 'transient kind: error_message verbatim');
  assert.equal(ig.status, 'pending', 'transient still retries — policy unchanged');
});
