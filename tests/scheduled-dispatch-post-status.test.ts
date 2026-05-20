import assert from 'node:assert/strict';
import test from 'node:test';

import { planPostStatusUpdate } from '../app/api/internal/publishing/scheduled-dispatch/route';

// F3 regression: a cross-post dispatches to several platforms independently.
// The route used to write posts.published_status per-platform, so a
// non-retryable failure on one platform clobbered the 'published' a sibling
// platform had just written. published_status is an OR-rollup, not the last
// platform's status.

test('FB success + IG terminal-fail => posts.published_status stays published', () => {
  const decision = planPostStatusUpdate([
    { ok: true },
    { ok: false, retryable: false },
  ]);
  assert.equal(
    decision,
    'published',
    'one platform live is a publish — the IG failure must not demote the post',
  );
});

test('FB success + IG retryable-fail => still published (FB went live)', () => {
  const decision = planPostStatusUpdate([
    { ok: true },
    { ok: false, retryable: true },
  ]);
  assert.equal(decision, 'published');
});

test('all platforms terminally failed => published_status failed', () => {
  const decision = planPostStatusUpdate([
    { ok: false, retryable: false },
    { ok: false, retryable: false },
  ]);
  assert.equal(decision, 'failed', 'every platform failed terminally — the post failed');
});

test('all failed but one retryable => leave status untouched (null)', () => {
  const decision = planPostStatusUpdate([
    { ok: false, retryable: false },
    { ok: false, retryable: true },
  ]);
  assert.equal(
    decision,
    null,
    'a retryable failure remains — do not write failed, the worker will retry',
  );
});

test('no platforms => no status write', () => {
  assert.equal(planPostStatusUpdate([]), null);
});

test('single-platform success => published', () => {
  assert.equal(planPostStatusUpdate([{ ok: true }]), 'published');
});

test('single-platform terminal failure => failed', () => {
  assert.equal(planPostStatusUpdate([{ ok: false, retryable: false }]), 'failed');
});
