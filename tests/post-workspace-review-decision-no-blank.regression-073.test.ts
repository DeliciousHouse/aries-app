import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * AA-73 regression: authorizing/rejecting a creative (and saving the brief) must
 * NOT blank the whole post workspace.
 *
 * Root cause was `job.load(props.postId, { quiet: false })` after the mutation:
 * `quiet: false` flips `job.isLoading`, which trips the top-level
 * `if (job.isLoading) return <Loading post…>` gate and unmounts the entire
 * workspace — indistinguishable from a full-page refresh. The fix makes the
 * post-mutation refetch quiet (per-item busy state still gives feedback; the
 * refetch still reconciles to server truth), so the review/brief updates in
 * place.
 *
 * Source-assertion test mirroring the existing post-workspace-*.test.ts pattern
 * (no jsdom; locks the load-bearing class/flag against regression).
 */

const SRC = readFileSync(
  fileURLToPath(new URL('../frontend/aries-v1/post-workspace.tsx', import.meta.url)),
  'utf8',
);

test('AA-73: no mutation refetch reloads the workspace non-quietly', () => {
  assert.ok(
    !SRC.includes('job.load(props.postId, { quiet: false })'),
    'a non-quiet job.load after a mutation re-trips the loading gate and blanks the whole workspace',
  );
});

test('AA-73: the review-decision handler still refetches (quietly) after a decision', () => {
  const start = SRC.indexOf('async function submitReviewDecision');
  assert.ok(start >= 0, 'submitReviewDecision handler not found');
  const body = SRC.slice(start, SRC.indexOf('async function submitBriefUpdate', start));
  assert.ok(
    body.includes('job.load(props.postId, { quiet: true })'),
    'submitReviewDecision must still refetch job status, but quietly (in place)',
  );
});

test('AA-73: the top-level loading gate is still present (fix relies on not reaching it, not deleting it)', () => {
  assert.match(
    SRC,
    /if \(job\.isLoading\)/,
    'the job.isLoading gate must remain; the fix avoids tripping it rather than removing it',
  );
});
