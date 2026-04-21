import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeReviewItem } from '../lib/api/aries-v1';
import { isDestructiveActionBlocked } from '../frontend/aries-v1/review-destructive-guard';
import { syncHistoryWithLastDecision } from '../backend/marketing/runtime-views';

// M3: unit-level guard validating the behavior the UI enforces — destructive
// actions (changes_requested / reject) must be blocked when the comment is
// empty. This is the SAME helper wired into frontend/aries-v1/review-item.tsx
// so if the UI drifts, these tests drift with it.
function canSubmit(action: 'approve' | 'changes_requested' | 'reject', note: string): boolean {
  return !isDestructiveActionBlocked(action, note);
}

test('M3: request-changes is blocked without a comment', () => {
  assert.equal(canSubmit('changes_requested', ''), false);
  assert.equal(canSubmit('changes_requested', '   '), false);
  assert.equal(canSubmit('changes_requested', 'needs a new headline'), true);
});

test('M3: reject is blocked without a comment', () => {
  assert.equal(canSubmit('reject', ''), false);
  assert.equal(canSubmit('reject', 'off-brand'), true);
});

test('M3: approve does NOT require a comment', () => {
  assert.equal(canSubmit('approve', ''), true);
});

// M4: the banner reads `item.lastDecision`; the Decision history panel reads
// `item.history`. These two sources must agree within one render of the
// /review/<id> screen after a decision is submitted. The real runtime helper
// is `syncHistoryWithLastDecision`, exported from backend/marketing/runtime-views.
function assertBannerAndHistoryAgree(item: Pick<RuntimeReviewItem, 'lastDecision' | 'history'>): void {
  if (!item.lastDecision) return;
  const match = item.history.find(
    (entry) => entry.action === item.lastDecision!.action && entry.at === item.lastDecision!.at,
  );
  if (!match) {
    throw new Error(
      `decision-history inconsistency: lastDecision=${JSON.stringify(item.lastDecision)} but history has ${item.history.length} entries`,
    );
  }
}

function baseReviewItem(overrides: Partial<RuntimeReviewItem> = {}): RuntimeReviewItem {
  return {
    id: 'job_x::approval',
    jobId: 'job_x',
    campaignId: 'job_x',
    campaignName: 'Demo',
    reviewType: 'workflow_approval',
    workflowState: 'in_review',
    workflowStage: 'strategy',
    title: 'Approve strategy',
    channel: 'Campaign',
    placement: 'strategy',
    scheduledFor: 'Before the next stage begins',
    status: 'changes_requested',
    summary: '',
    currentVersion: { id: 'approval:abc', label: '', headline: '', supportingText: '', cta: '', notes: [] },
    sections: [],
    attachments: [],
    history: [],
    ...overrides,
  };
}

test('M4: syncHistoryWithLastDecision synthesizes a stage_review history entry for stage items', () => {
  const at = '2026-04-21T13:00:00.000Z';
  const out = syncHistoryWithLastDecision(
    baseReviewItem({
      reviewType: 'brand',
      lastDecision: { action: 'changes_requested', actedBy: 'Client reviewer', note: 'update offer', at },
    }),
  );
  assert.equal(out.history.length, 1);
  assert.equal(out.history[0].type, 'stage_review');
  assert.equal(out.history[0].action, 'changes_requested');
  assert.equal(out.history[0].status, 'changes_requested');
  assertBannerAndHistoryAgree(out);
});

test('M4: syncHistoryWithLastDecision picks creative_asset_review type for per-asset creative reviews', () => {
  const at = '2026-04-21T14:00:00.000Z';
  const out = syncHistoryWithLastDecision(
    baseReviewItem({
      reviewType: 'creative',
      assetId: 'asset_42',
      lastDecision: { action: 'reject', actedBy: 'Client reviewer', note: 'off-brand', at },
    }),
  );
  assert.equal(out.history.length, 1);
  assert.equal(
    out.history[0].type,
    'creative_asset_review',
    'creative asset decisions must use creative_asset_review type, not stage_review',
  );
  assert.equal(out.history[0].assetId, 'asset_42');
  assert.equal(out.history[0].status, 'rejected');
  assertBannerAndHistoryAgree(out);
});

test('M4: workflow_approval items stay as stage_review (they have no assetId)', () => {
  const at = '2026-04-21T15:00:00.000Z';
  const out = syncHistoryWithLastDecision(
    baseReviewItem({
      reviewType: 'workflow_approval',
      lastDecision: { action: 'approve', actedBy: 'Client reviewer', note: null, at },
    }),
  );
  assert.equal(out.history.length, 1);
  assert.equal(out.history[0].type, 'stage_review');
  assert.equal(out.history[0].status, 'approved');
});

test('M4: no lastDecision => history is untouched', () => {
  const item = baseReviewItem({ lastDecision: undefined });
  const out = syncHistoryWithLastDecision(item);
  assert.equal(out.history.length, 0);
  assert.strictEqual(out, item);
});

test('M4: already-recorded decision is not duplicated', () => {
  const at = '2026-04-21T16:00:00.000Z';
  const item = baseReviewItem({
    reviewType: 'strategy',
    lastDecision: { action: 'approve', actedBy: 'Client reviewer', note: null, at },
    history: [
      {
        id: 'h1',
        at,
        actor: 'Client reviewer',
        type: 'stage_review',
        workflowState: 'in_review',
        action: 'approve',
        note: null,
        status: 'approved',
      },
    ],
  });
  const out = syncHistoryWithLastDecision(item);
  assert.equal(out.history.length, 1);
});
