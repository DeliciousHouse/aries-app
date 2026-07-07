import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planPostStatusUpdate,
  deriveDispatchRetryable,
} from '../app/api/internal/publishing/scheduled-dispatch/route';
import { MetaPublishError } from '../backend/integrations/meta-publishing';
import {
  ComposioToolError,
  ComposioCapabilityMissingError,
} from '../backend/integrations/composio/errors';

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

// --- deriveDispatchRetryable ---------------------------------------------------
// The route used to hardcode `retryable = true` for every non-Meta throw, so a
// permanent Composio broker verdict (Reddit SUBREDDIT_NOEXIST with no target
// subreddit configured) kept dispatch_status='pending' and the standing worker
// re-claimed + re-failed the row every 60s tick forever. The derivation honors
// an EXPLICIT `retryable === false` on any error (the IntegrationError family)
// as terminal; everything unrecognized stays retryable (fail-safe).

test('deriveDispatchRetryable: MetaPublishError carries its own retryable flag', () => {
  assert.equal(
    deriveDispatchRetryable(new MetaPublishError('rate_limited', 'try later', { retryable: true })),
    true,
  );
  assert.equal(
    deriveDispatchRetryable(new MetaPublishError('bad_media', 'unsupported image', { retryable: false })),
    false,
  );
});

test('deriveDispatchRetryable: outcome-unknown MetaPublishError is never retried (duplicate-post guard)', () => {
  const outcomeUnknown = new MetaPublishError('publish_unconfirmed', 'accepted but no post id', {
    retryable: false,
    outcomeUnknown: true,
  });
  assert.equal(
    deriveDispatchRetryable(outcomeUnknown),
    false,
    'a publish that MAY be live must not auto-retry — a retry of a secret success is a duplicate post',
  );
});

test('deriveDispatchRetryable: default ComposioToolError (transient broker verdict) stays retryable', () => {
  assert.equal(
    deriveDispatchRetryable(new ComposioToolError('REDDIT_CREATE_REDDIT_POST', 'gateway blip')),
    true,
    'a non-terminal broker verdict is re-claimed by the worker next tick',
  );
});

test('deriveDispatchRetryable: terminal ComposioToolError (SUBREDDIT_NOEXIST) self-terminates', () => {
  const terminal = new ComposioToolError(
    'REDDIT_CREATE_REDDIT_POST',
    "[['SUBREDDIT_NOEXIST', 'that community does not exist', 'sr']]",
    { terminal: true },
  );
  assert.equal(
    deriveDispatchRetryable(terminal),
    false,
    'a permanent broker verdict must fail terminal — not retry-spam every worker tick',
  );
});

test('deriveDispatchRetryable: ComposioCapabilityMissingError (no target subreddit) is terminal', () => {
  assert.equal(
    deriveDispatchRetryable(new ComposioCapabilityMissingError('reddit', 'publish without a target subreddit')),
    false,
    'capability-missing inherits retryable=false — retrying without config can only fail the same way',
  );
});

test('deriveDispatchRetryable: unrecognized errors default to retryable (fail-safe)', () => {
  assert.equal(deriveDispatchRetryable(new Error('ECONNRESET')), true, 'a raw network throw is retried');
  assert.equal(deriveDispatchRetryable('string throw'), true);
  assert.equal(deriveDispatchRetryable(null), true);
  assert.equal(deriveDispatchRetryable(undefined), true);
});

test('deriveDispatchRetryable: only an explicit boolean false buries a failure', () => {
  assert.equal(
    deriveDispatchRetryable({ retryable: 'false' }),
    true,
    'a non-boolean retryable value must NOT be honored as terminal',
  );
  assert.equal(deriveDispatchRetryable({ retryable: undefined }), true);
  assert.equal(deriveDispatchRetryable({ retryable: 0 }), true);
  assert.equal(deriveDispatchRetryable({ retryable: false }), false, 'an explicit false is honored');
});
