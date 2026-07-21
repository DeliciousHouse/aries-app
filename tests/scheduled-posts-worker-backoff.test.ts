import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Backoff regression (2026-07-13 incident): five FB posts stuck on Facebook's
// rate limit (error 368) were re-claimed and re-sent EVERY 60s worker tick for
// ~6 days — each retry another FACEBOOK_CREATE_PHOTO_POST call that kept the
// rate limit tripped. The worker now writes scheduled_posts.next_attempt_at
// after a non-terminal outcome and the due/claim SQL skips pending rows whose
// backoff has not passed. The worker is a .mjs script (no type declarations),
// so — matching scheduled-posts-worker-query.test.ts — the SQL is asserted at
// source level and the pure classifier is imported dynamically.

const workerPath = path.join(REPO_ROOT, 'scripts/automations/scheduled-posts-worker.mjs');
const workerSource = readFileSync(workerPath, 'utf8');

function extractSql(name: string): string {
  const match = workerSource.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`));
  assert.ok(match, `${name} must be defined and exported in the worker`);
  return match![1];
}

test('DUE_ROWS_SQL: pending arm honors next_attempt_at; stale-in_flight arm does not', () => {
  const sql = extractSql('DUE_ROWS_SQL');
  const pendingArm = sql.slice(0, sql.indexOf("in_flight'"));
  assert.match(pendingArm, /next_attempt_at IS NULL OR next_attempt_at <= NOW\(\)/);
  // The reclaim arm must stay unconditioned on next_attempt_at — a crashed
  // worker pass is not a backoff.
  const reclaimArm = sql.slice(sql.indexOf("dispatch_status = 'in_flight'"));
  assert.doesNotMatch(reclaimArm, /next_attempt_at/);
});

test('CLAIM_ROW_SQL: pending arm honors next_attempt_at; stale-in_flight arm does not', () => {
  const sql = extractSql('CLAIM_ROW_SQL');
  const pendingArm = sql.slice(0, sql.indexOf("in_flight'"));
  assert.match(pendingArm, /next_attempt_at IS NULL OR sp\.next_attempt_at <= NOW\(\)/);
  const reclaimArm = sql.slice(sql.indexOf("dispatch_status = 'in_flight'"));
  assert.doesNotMatch(reclaimArm, /next_attempt_at/);
});

test('init-db.js ships the next_attempt_at column the worker SQL depends on', () => {
  const initDb = readFileSync(path.join(REPO_ROOT, 'scripts/init-db.js'), 'utf8');
  assert.match(initDb, /ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ/);
});

test('pending child rows now persist their error_message (silent-retry observability)', () => {
  assert.match(
    workerSource,
    /WHEN \$3 = 'pending' AND \$4::text IS NOT NULL THEN \$4::text/,
    'setPlatformDispatchStatus must record the retryable error on pending children',
  );
});

test('classifyRetryBackoffMinutes: FB 368 → rate-limit tier; generic → general tier; none → null', async () => {
  const worker = await import(workerPath);
  const classify = worker.classifyRetryBackoffMinutes as (
    outcomes: Array<{ status: string; error?: string | null }>,
    env?: Record<string, string>,
  ) => number | null;

  const fb368 = [{
    status: 'pending',
    error: 'Composio tool FACEBOOK_CREATE_PHOTO_POST failed: Facebook API error (code 368): We limit how often you can post... You can try again later.',
  }];
  assert.equal(classify(fb368, {}), 180, 'FB 368 gets the long rate-limit backoff');

  const generic = [{ status: 'pending', error: 'fetch failed after retry: socket hang up' }];
  assert.equal(classify(generic, {}), 10, 'generic retryable failures get the short backoff');

  const requestLimit = [{ status: 'pending', error: '(#17) User request limit reached' }];
  assert.equal(classify(requestLimit, {}), 180, 'Graph request-limit text classifies as rate limit');

  assert.equal(classify([{ status: 'dispatched' }], {}), null, 'nothing retrying → no backoff write');
  assert.equal(classify([{ status: 'failed', error: 'terminal' }], {}), null, 'terminal failures → no backoff write');

  assert.equal(
    classify(generic, { ARIES_DISPATCH_RETRY_BACKOFF_MINUTES: '25' }),
    25,
    'general tier is env-tunable',
  );
  assert.equal(
    classify(fb368, { ARIES_DISPATCH_RATE_LIMIT_BACKOFF_MINUTES: '360' }),
    360,
    'rate-limit tier is env-tunable',
  );
  assert.equal(
    classify(generic, { ARIES_DISPATCH_RETRY_BACKOFF_MINUTES: 'garbage' }),
    10,
    'invalid env falls back to the default',
  );
});

test('a (re)schedule upsert clears next_attempt_at — operator reschedules beat stale backoff', () => {
  // Nothing else ever clears the backoff marker, so without this reset a
  // manually rescheduled row would silently ignore its new scheduled_for
  // until the old next_attempt_at passed.
  const upsertSource = readFileSync(
    path.join(REPO_ROOT, 'backend/social-content/scheduled-posts.ts'),
    'utf8',
  );
  const conflictClause = upsertSource.slice(upsertSource.indexOf('ON CONFLICT (post_id) DO UPDATE'));
  assert.match(conflictClause, /next_attempt_at = NULL/);
});

test('setPlatformDispatchStatus casts $4 to text — bare $4 fails Postgres prepare (42P08)', () => {
  // Postgres cannot infer $4's type when the bare parameter appears in both a
  // CASE result and an IS NOT NULL predicate; the statement then fails at
  // prepare time and EVERY post-publish write dies — the publish goes live
  // but is never recorded, re-opening the stale-reclaim duplicate window
  // (caught live 2026-07-13 20:05Z). In-memory fakes cannot see prepare-time
  // inference, so pin the casts at source level. Anchored to the
  // setPlatformDispatchStatus function — the dead-campaign sweep CTE contains
  // an earlier `UPDATE scheduled_post_dispatches` that must not shift this
  // slice onto unrelated text.
  const fnStart = workerSource.indexOf('async function setPlatformDispatchStatus');
  assert.notEqual(fnStart, -1, 'setPlatformDispatchStatus must exist in the worker');
  const stmt = workerSource.slice(
    workerSource.indexOf('UPDATE scheduled_post_dispatches', fnStart),
    workerSource.indexOf('WHERE scheduled_post_id = $1 AND platform = $2', fnStart),
  );
  const bare = stmt.match(/\$4(?!::text)/g) ?? [];
  assert.equal(bare.length, 0, `every $4 in the child-status UPDATE must be cast ::text; found ${bare.length} bare`);
});
