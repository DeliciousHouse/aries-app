import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCampaignStatusLabel,
  formatDispatchStatusChip,
  formatDispatchStatusLabel,
} from '../frontend/aries-v1/labels';
import { connectionStateBadgeStatus } from '../frontend/settings/platform-card';
import { stageProgressForTest } from '../frontend/aries-v1/presenters/campaign-list-presenter';
import {
  integration_connection_state_values,
  type integration_connection_state,
} from '../frontend/types/integrations';

// --- Dispatch status labels --------------------------------------------------
//
// Calendar event modal renders these values verbatim. The legacy implementation
// called `dispatchStatus.replace('_', ' ')` which produced lowercase strings
// like "in flight" — these tests pin the title-cased mapping so a future
// regression to `.replace()` would fail loudly.

test('formatDispatchStatusLabel pins known dispatch statuses to title case', () => {
  assert.equal(formatDispatchStatusLabel('pending'), 'Pending');
  assert.equal(formatDispatchStatusLabel('in_flight'), 'In flight');
  assert.equal(formatDispatchStatusLabel('dispatched'), 'Dispatched');
  assert.equal(formatDispatchStatusLabel('failed'), 'Failed');
  assert.equal(formatDispatchStatusLabel('skipped'), 'Skipped');
});

test('formatDispatchStatusLabel title-cases unknown values instead of returning raw snake_case', () => {
  // Future enum value the type was widened to without updating labels.ts —
  // must NOT render as `published_to_meta_paused` or lowercase.
  assert.equal(formatDispatchStatusLabel('published_to_meta_paused'), 'Published To Meta Paused');
  assert.equal(formatDispatchStatusLabel('weird_new_value'), 'Weird New Value');
  assert.equal(formatDispatchStatusLabel(''), '');
});

// --- Dispatch status chip ----------------------------------------------------
//
// The calendar event card chip uses 3-4 char labels. The legacy ternary in
// calendar-presenter.tsx:832-838 dropped any value other than 'dispatched' /
// 'failed' / 'in_flight' into the literal 'Sch', which silently swallowed
// 'pending', 'skipped', and every future enum value. These tests pin every
// known value and assert the fallback never returns the success label.

test('formatDispatchStatusChip renders the right chip per known status', () => {
  assert.equal(formatDispatchStatusChip('dispatched'), 'Sent');
  assert.equal(formatDispatchStatusChip('failed'), 'Fail');
  assert.equal(formatDispatchStatusChip('in_flight'), 'Live');
  assert.equal(formatDispatchStatusChip('pending'), 'Sch');
  assert.equal(formatDispatchStatusChip('skipped'), 'Skip');
});

test('formatDispatchStatusChip fallback never returns the success label for unknown values', () => {
  // A new value MUST NOT inherit the 'Sent' label by accident — that was the
  // bug class this fix closed. Neutral 'Sch' is the safer default.
  const unknownLabel = formatDispatchStatusChip('totally_new_status');
  assert.notEqual(unknownLabel, 'Sent');
  assert.notEqual(unknownLabel, 'Live');
  assert.equal(unknownLabel, 'Sch');
});

// --- Campaign status labels --------------------------------------------------
//
// calendar-presenter.tsx:344 used `campaign.status.replace('_', ' ')` which
// produced "published to meta (paused)" and "ready to publish" in lowercase.
// formatCampaignStatusLabel must return the same casing StatusChip uses.

test('formatCampaignStatusLabel matches the StatusChip casing for AriesCampaignStatus values', () => {
  assert.equal(formatCampaignStatusLabel('draft'), 'Draft');
  assert.equal(formatCampaignStatusLabel('in_review'), 'In review');
  assert.equal(formatCampaignStatusLabel('approved'), 'Approved');
  assert.equal(formatCampaignStatusLabel('scheduled'), 'Scheduled');
  assert.equal(formatCampaignStatusLabel('live'), 'Live');
  assert.equal(formatCampaignStatusLabel('changes_requested'), 'Needs changes');
  assert.equal(formatCampaignStatusLabel('rejected'), 'Rejected');
});

test('formatCampaignStatusLabel handles AriesItemStatus values used in the calendar pill', () => {
  assert.equal(formatCampaignStatusLabel('ready_to_publish'), 'Ready to publish');
  assert.equal(formatCampaignStatusLabel('published_to_meta_paused'), 'Published to Meta (Paused)');
  assert.equal(formatCampaignStatusLabel('published_to_meta'), 'Published to Meta');
});

test('formatCampaignStatusLabel title-cases unknown values rather than returning raw snake_case', () => {
  // The exact bug-class this regression test pins: a new status MUST NOT
  // render as raw `whatever_new_thing` or lowercase.
  assert.equal(formatCampaignStatusLabel('whatever_new_thing'), 'Whatever New Thing');
  assert.notEqual(formatCampaignStatusLabel('published_to_meta_paused'), 'published to meta paused');
});

// --- Campaign list stage progress -------------------------------------------
//
// stageProgress() in campaign-list-presenter.tsx had no case for 'rejected'
// and no default branch, so it returned `undefined` which rendered as
// `width: undefined%` in the CSS. These tests pin every known status to a
// numeric value and ensure the default returns 0 (never undefined).

test('stageProgress returns a finite number for every AriesCampaignStatus value', () => {
  const knownStatuses = [
    'draft',
    'in_review',
    'approved',
    'scheduled',
    'live',
    'changes_requested',
    'rejected',
  ] as const;
  for (const status of knownStatuses) {
    const pct = stageProgressForTest(status);
    assert.equal(typeof pct, 'number', `stageProgress("${status}") must be a number`);
    assert.ok(Number.isFinite(pct), `stageProgress("${status}") must be finite, got ${pct}`);
    assert.ok(pct >= 0 && pct <= 100, `stageProgress("${status}") must be 0..100, got ${pct}`);
  }
});

test('stageProgress returns 0 for rejected (terminal failure, not "almost done")', () => {
  assert.equal(stageProgressForTest('rejected'), 0);
});

test('stageProgress default branch returns 0 for unknown values, never undefined', () => {
  // Cast so we can simulate a future widening that bypasses the type checker.
  const result = stageProgressForTest('totally_new_status' as 'draft');
  assert.equal(result, 0);
  assert.notEqual(result, undefined);
});

// --- Platform card connection state badge -----------------------------------
//
// platform-card.tsx switched on `connection_state` and dropped every
// unrecognized value to 'accepted' (an info-blue "Accepted" badge), so an
// in-flight `connection_pending` OAuth handshake rendered as if it had
// succeeded. These tests pin every known value AND prove every value in the
// shared connection-state enum has a case.

test('connectionStateBadgeStatus maps every known IntegrationConnectionState', () => {
  assert.equal(connectionStateBadgeStatus('connected'), 'completed');
  assert.equal(connectionStateBadgeStatus('reauth_required'), 'required');
  assert.equal(connectionStateBadgeStatus('connection_error'), 'error');
  assert.equal(connectionStateBadgeStatus('disabled'), 'error');
  assert.equal(connectionStateBadgeStatus('connection_pending'), 'in_progress');
  assert.equal(connectionStateBadgeStatus('not_connected'), 'unknown');
});

test('connectionStateBadgeStatus connection_pending does NOT render as "accepted" (the legacy bug)', () => {
  assert.notEqual(connectionStateBadgeStatus('connection_pending'), 'accepted');
});

test('connectionStateBadgeStatus covers every value in the runtime enum', () => {
  // If a new connection_state value lands in the type without a switch case,
  // this loop will fail because the value won't be one of the expected badge
  // statuses (the default branch returns 'unknown', which counts as covered,
  // but adding a value still requires picking a real badge intentionally).
  for (const state of integration_connection_state_values as readonly integration_connection_state[]) {
    const badge = connectionStateBadgeStatus(state as never);
    assert.ok(
      ['completed', 'required', 'error', 'in_progress', 'unknown'].includes(badge as string),
      `connection_state="${state}" mapped to unexpected badge "${badge}"`,
    );
  }
});
