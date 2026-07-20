import assert from 'node:assert/strict';
import test from 'node:test';

import { createSocialContentListViewModel } from '../frontend/aries-v1/view-models/post-list';
import type { AriesDashboardStatusSummary, RuntimePostListItem } from '../lib/api/aries-v1';

function buildStatusSummary(): AriesDashboardStatusSummary {
  return {
    countsByStatus: {
      draft: 0,
      in_review: 0,
      ready: 0,
      ready_to_publish: 0,
      published_to_meta_paused: 0,
      scheduled: 0,
      live: 0,
    },
  };
}

function buildCampaign(overrides: Partial<RuntimePostListItem> = {}): RuntimePostListItem {
  return {
    id: 'campaign-1',
    jobId: 'campaign-1',
    name: 'Campaign Alpha',
    objective: 'Drive demo requests',
    funnelStage: 'Conversion',
    status: 'draft',
    dashboardStatus: 'draft',
    executionState: 'running',
    stageLabel: 'research',
    summary: 'Proof-led launch campaign.',
    dateRange: 'Dates not scheduled yet',
    pendingApprovals: 0,
    nextScheduled: 'Nothing scheduled yet',
    trustNote: 'Nothing goes live without approval.',
    updatedAt: '2026-03-27T00:00:00.000Z',
    approvalRequired: false,
    counts: {
      posts: 0,
      landingPages: 0,
      imageAds: 0,
      videoAds: 0,
      scripts: 0,
      publishItems: 0,
      proposalConcepts: 0,
      ready: 0,
      readyToPublish: 0,
      pausedMetaAds: 0,
      scheduled: 0,
      live: 0,
    },
    previewPosts: [],
    previewAssets: [],
    dashboard: {
      post: null,
      posts: [],
      assets: [],
      publishItems: [],
      calendarEvents: [],
      statuses: buildStatusSummary(),
    },
    ...overrides,
  };
}

test('social content list marks a failed job and provides a detailed failure action', () => {
  const model = createSocialContentListViewModel([
    buildCampaign({ executionState: 'failed', stageLabel: 'research' }),
  ]);

  assert.equal(model.items[0].failed, true);
  assert.equal(model.items[0].failureLabel, 'Research failed');
  assert.equal(model.items[0].actionLabel, 'View failure details');
  assert.equal(model.items[0].href, '/dashboard/social-content/campaign-1');
});

test('social content list treats a stale failed job as the same actionable failure state', () => {
  const model = createSocialContentListViewModel([
    buildCampaign({ executionState: 'failed_stale', stageLabel: 'strategy' }),
  ]);

  assert.equal(model.items[0].failed, true);
  assert.equal(model.items[0].failureLabel, 'Strategy failed');
  assert.equal(model.items[0].actionLabel, 'View failure details');
  assert.equal(model.items[0].href, '/dashboard/social-content/campaign-1');
});

test('social content list keeps a healthy running research job unchanged', () => {
  const model = createSocialContentListViewModel([buildCampaign()]);

  assert.equal(model.items[0].failed, false);
  assert.equal(model.items[0].failureLabel, null);
  assert.equal(model.items[0].actionLabel, null);
  assert.equal(model.items[0].stageLabel, 'research');
  assert.equal(model.items[0].pendingApprovals, '0');
});
