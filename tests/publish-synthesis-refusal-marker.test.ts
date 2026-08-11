import assert from 'node:assert/strict';
import test from 'node:test';

import { markPublishBlockedOnSynthesisRefusal } from '../backend/marketing/hermes-callbacks';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';

// ---------------------------------------------------------------------------
// AA-217 — a synthesis that REFUSED for want of a connected channel must not
// read as a finished week.
//
// Ordering is the whole point: the terminal Hermes callback sets
// doc.state/status = 'completed' and marks the publish stage completed BEFORE
// synthesis runs. So the doc under test starts in exactly that state, and the
// assertion is that the refusal overrides it.
// ---------------------------------------------------------------------------

function completedDoc(): SocialContentJobRuntimeDocument {
  return {
    job_id: 'job-refusal',
    tenant_id: '70',
    state: 'completed',
    status: 'completed',
    current_stage: 'publish',
    history: [],
    stages: {
      publish: {
        status: 'completed',
        started_at: '2026-08-10T00:00:00.000Z',
        completed_at: '2026-08-10T01:00:00.000Z',
        failed_at: null,
        errors: [],
        artifacts: [],
        outputs: { schedule: [] },
      },
    },
  } as unknown as SocialContentJobRuntimeDocument;
}

test('no_connected_platform flips a completed publish stage to requires_channel_connection', () => {
  const doc = completedDoc();
  const marked = markPublishBlockedOnSynthesisRefusal(doc, { reason: 'no_connected_platform' });

  assert.equal(marked, true, 'the caller is told the doc was marked');
  assert.equal(doc.stages.publish.status, 'requires_channel_connection');
  assert.equal(doc.state, 'needs_connection');
  assert.equal(doc.status, 'needs_connection');
  // Otherwise the job renders as simultaneously done AND awaiting a connection.
  assert.equal(doc.stages.publish.completed_at, null, 'terminal timestamp cleared');
  // The operator gets a channel-connection artifact to act on, not a bare state.
  const artifact = doc.stages.publish.artifacts.find((a) => a.id === 'publish-needs-channel');
  assert.ok(artifact, 'a connect-a-channel artifact is attached');
  assert.equal(artifact?.category, 'channel_connection');
  assert.equal(artifact?.action_href, '/dashboard/settings/channel-integrations');
  // And an audit trail entry explaining why an otherwise-complete run has no posts.
  assert.ok(
    (doc.history ?? []).some((h) => String(h.note ?? '').includes('no connected publishing channel')),
    'history records the cause',
  );
  // Stage outputs survive so the strategist's schedule is not lost.
  assert.deepEqual(doc.stages.publish.outputs, { schedule: [] });
});

test('every other synthesis reason leaves the completed doc untouched', () => {
  // publish_package_present / no_content_package are ordinary no-ops, and
  // no_tenant is a malformed-id guard — none of them mean "connect a channel".
  for (const reason of [undefined, 'publish_package_present', 'no_content_package', 'no_tenant']) {
    const doc = completedDoc();
    const marked = markPublishBlockedOnSynthesisRefusal(doc, reason ? { reason } : {});
    assert.equal(marked, false, `reason=${String(reason)} must not mark`);
    assert.equal(doc.state, 'completed', `reason=${String(reason)} must not change state`);
    assert.equal(doc.stages.publish.status, 'completed');
    assert.equal(doc.stages.publish.completed_at, '2026-08-10T01:00:00.000Z');
  }
});

test('a null/undefined synthesis result is a no-op (defensive)', () => {
  for (const result of [null, undefined]) {
    const doc = completedDoc();
    assert.equal(markPublishBlockedOnSynthesisRefusal(doc, result), false);
    assert.equal(doc.state, 'completed');
  }
});
