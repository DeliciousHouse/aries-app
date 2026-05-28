// Slice B: campaign workspace must surface "Completed (no content)" instead
// of falling through to "Draft" when a marketing run reaches runtime
// state=completed but produced no publish-ready or published content.
//
// Motivation: mkt_bb1c146c-* QA finding — the run had state=completed but
// publish_ready=false, and the workspace header rendered "Draft" because the
// state resolver had no case for "completed but empty" and the label fallback
// title-cased the raw workflow state.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSocialContentWorkflowState } from '../backend/marketing/workspace-store';
import type { SocialContentWorkflowSnapshot, SocialContentWorkspaceRecord } from '../backend/marketing/workspace-store';
import { workflowStateLabel, workflowStateTone } from '../frontend/aries-v1/post-workspace';

function makeRecord(): SocialContentWorkspaceRecord {
  const ts = '2026-05-26T00:00:00.000Z';
  return {
    schema_name: 'marketing_campaign_workspace',
    schema_version: '1.0.0',
    job_id: 'mkt_test_001',
    tenant_id: '42',
    workflow_state: 'draft',
    brief: {
      websiteUrl: 'https://aries.sugarandleather.com/',
      businessName: '',
      businessType: '',
      approverName: '',
      goal: '',
      offer: '',
      competitorUrl: '',
      channels: [],
      brandVoice: '',
      styleVibe: '',
      visualReferences: [],
      mustUseCopy: '',
      mustAvoidAesthetics: '',
      notes: '',
      brandAssets: [],
    },
    stage_reviews: {
      brand: { status: 'not_ready', latestNote: null, updatedAt: null, evidenceKind: null },
      strategy: { status: 'not_ready', latestNote: null, updatedAt: null, evidenceKind: null },
      creative: { status: 'not_ready', latestNote: null, updatedAt: null, evidenceKind: null },
    },
    creative_asset_reviews: {},
    status_history: [],
    created_at: ts,
    updated_at: ts,
  };
}

function makeSnapshot(overrides: Partial<SocialContentWorkflowSnapshot> = {}): SocialContentWorkflowSnapshot {
  return {
    brandWorkflowReady: false,
    strategyReviewReady: false,
    creativeReviewReady: false,
    creativeAssetIds: [],
    publishReadySignal: false,
    publishedSignal: false,
    completedSignal: false,
    ...overrides,
  };
}

test('resolveSocialContentWorkflowState: completedSignal + no publish content → completed_no_content', () => {
  const record = makeRecord();
  const snapshot = makeSnapshot({ completedSignal: true });
  const resolution = resolveSocialContentWorkflowState(record, snapshot);
  assert.equal(resolution.workflowState, 'completed_no_content');
  assert.match(
    resolution.publishBlockedReason ?? '',
    /completed.*no publishable content/i,
    'publishBlockedReason explains why',
  );
});

test('resolveSocialContentWorkflowState: completedSignal=false + no publish content → draft (unchanged)', () => {
  const record = makeRecord();
  const snapshot = makeSnapshot({ completedSignal: false });
  const resolution = resolveSocialContentWorkflowState(record, snapshot);
  assert.equal(resolution.workflowState, 'draft');
});

test('resolveSocialContentWorkflowState: completedSignal=true but publishReadySignal=true → ready_to_publish wins', () => {
  const record = makeRecord();
  const snapshot = makeSnapshot({ completedSignal: true, publishReadySignal: true });
  const resolution = resolveSocialContentWorkflowState(record, snapshot);
  assert.equal(resolution.workflowState, 'ready_to_publish');
});

test('resolveSocialContentWorkflowState: completedSignal=true but publishedSignal=true → published wins', () => {
  const record = makeRecord();
  const snapshot = makeSnapshot({ completedSignal: true, publishedSignal: true });
  const resolution = resolveSocialContentWorkflowState(record, snapshot);
  assert.equal(resolution.workflowState, 'published');
});

test('workflowStateLabel: completed_no_content renders as "Completed (no content)"', () => {
  assert.equal(workflowStateLabel('completed_no_content'), 'Completed (no content)');
});

test('workflowStateLabel: completed_no_content does NOT title-case to "Completed No Content"', () => {
  // Regression: the previous fallback title-cased unknown states. This test
  // pins the explicit label so a future refactor does not regress.
  assert.notEqual(workflowStateLabel('completed_no_content'), 'Completed No Content');
});

test('workflowStateLabel: completed_no_content header MUST NOT read "Draft"', () => {
  // The mkt_bb1c146c-* incident: header rendered "Draft" because the state
  // fell through to the default branch. After this fix the resolver yields
  // 'completed_no_content', so the label must reflect that — never "Draft".
  assert.notEqual(workflowStateLabel('completed_no_content'), 'Draft');
});

test('workflowStateTone: completed_no_content uses an attention tone (not default amber)', () => {
  const tone = workflowStateTone('completed_no_content');
  // Attention tone is rose-class to signal "Needs attention", distinct from
  // the default amber used for in-progress / unknown states.
  assert.match(tone, /rose/);
});
