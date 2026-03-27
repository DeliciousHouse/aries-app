import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AriesDashboardPublishItem,
  AriesDashboardStatusSummary,
  RuntimeCampaignListItem,
} from '../lib/api/aries-v1';
import { createDashboardHomeViewModel } from '../frontend/aries-v1/view-models/dashboard-home';

function buildStatusSummary(
  overrides: Partial<AriesDashboardStatusSummary['countsByStatus']> = {},
): AriesDashboardStatusSummary {
  return {
    countsByStatus: {
      draft: 0,
      in_review: 0,
      ready: 0,
      ready_to_publish: 0,
      published_to_meta_paused: 0,
      scheduled: 0,
      live: 0,
      ...overrides,
    },
  };
}

function buildPublishItem(
  overrides: Partial<AriesDashboardPublishItem> = {},
): AriesDashboardPublishItem {
  return {
    id: 'publish-item-1',
    campaignId: 'campaign-1',
    jobId: 'campaign-1',
    type: 'pre_publish_review',
    title: 'Launch hero ad',
    summary: 'Ready for final review before activation.',
    platform: 'meta',
    platformLabel: 'Meta',
    campaignName: 'Campaign Alpha',
    funnelStage: 'Conversion',
    objective: 'Drive demo requests',
    destinationUrl: 'https://example.com/demo',
    previewAssetId: null,
    status: 'ready_to_publish',
    createdAt: '2026-03-27T00:00:00.000Z',
    relatedAssetIds: [],
    relatedPostIds: [],
    provenance: {
      sourceKind: 'publish_review',
      sourceStage: 'publish',
      sourceRunId: 'run-publish',
      isDerivedSchedule: false,
      isPlatformNative: false,
    },
    ...overrides,
  };
}

function buildCampaign(overrides: Partial<RuntimeCampaignListItem> = {}): RuntimeCampaignListItem {
  return {
    id: 'campaign-1',
    jobId: 'campaign-1',
    name: 'Campaign Alpha',
    objective: 'Drive demo requests',
    funnelStage: 'Conversion',
    status: 'draft',
    dashboardStatus: 'draft',
    stageLabel: 'production',
    summary: 'Proof-led launch campaign.',
    dateRange: 'Dates not scheduled yet',
    pendingApprovals: 0,
    nextScheduled: 'Nothing scheduled yet',
    trustNote: 'Nothing goes live without approval.',
    updatedAt: '2026-03-27T00:00:00.000Z',
    approvalRequired: false,
    counts: {
      posts: 1,
      landingPages: 0,
      imageAds: 0,
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
      campaign: null,
      posts: [],
      assets: [],
      publishItems: [],
      calendarEvents: [],
      statuses: buildStatusSummary(),
    },
    ...overrides,
  };
}

test('ready-to-publish items outrank opening the latest campaign in next action', () => {
  const model = createDashboardHomeViewModel({
    campaigns: [
      buildCampaign({
        counts: {
          posts: 1,
          landingPages: 1,
          imageAds: 1,
          scripts: 1,
          publishItems: 1,
          proposalConcepts: 0,
          ready: 0,
          readyToPublish: 2,
          pausedMetaAds: 1,
          scheduled: 0,
          live: 0,
        },
        dashboardStatus: 'ready_to_publish',
        dashboard: {
          campaign: null,
          posts: [],
          assets: [],
          publishItems: [
            buildPublishItem(),
            buildPublishItem({
              id: 'publish-item-2',
              status: 'published_to_meta_paused',
              type: 'meta_paused_ad',
              title: 'Meta retargeting ad',
            }),
          ],
          calendarEvents: [],
          statuses: buildStatusSummary({
            ready_to_publish: 2,
            published_to_meta_paused: 1,
          }),
        },
      }),
    ],
    reviews: [],
    profile: null,
    integrationCards: [],
  });

  assert.equal(model.nextAction.href, '/dashboard/posts');
  assert.equal(model.nextAction.label, 'Open posts');
  assert.equal(model.publish.count, 3);
});

test('live campaigns produce results-oriented working-now messaging', () => {
  const model = createDashboardHomeViewModel({
    campaigns: [
      buildCampaign({
        status: 'live',
        dashboardStatus: 'live',
        nextScheduled: '2026-03-29T10:00:00.000Z · Live · Meta',
        counts: {
          posts: 2,
          landingPages: 1,
          imageAds: 1,
          scripts: 1,
          publishItems: 1,
          proposalConcepts: 0,
          ready: 0,
          readyToPublish: 0,
          pausedMetaAds: 0,
          scheduled: 0,
          live: 1,
        },
        dashboard: {
          campaign: null,
          posts: [],
          assets: [],
          publishItems: [],
          calendarEvents: [],
          statuses: buildStatusSummary({
            live: 1,
          }),
        },
      }),
    ],
    reviews: [],
    profile: null,
    integrationCards: [],
  });

  assert.equal(model.workingNow.mode, 'results');
  assert.equal(model.workingNow.href, '/dashboard/results');
  assert.equal(model.results.items.length, 1);
  assert.match(model.workingNow.title, /result signal/i);
});

test('publish-ready work produces publish-oriented working-now messaging before live results exist', () => {
  const model = createDashboardHomeViewModel({
    campaigns: [
      buildCampaign({
        dashboardStatus: 'ready_to_publish',
        nextScheduled: '2026-03-28T10:00:00.000Z · Ready to Publish · Meta',
        counts: {
          posts: 1,
          landingPages: 1,
          imageAds: 1,
          scripts: 1,
          publishItems: 1,
          proposalConcepts: 0,
          ready: 0,
          readyToPublish: 1,
          pausedMetaAds: 0,
          scheduled: 0,
          live: 0,
        },
        dashboard: {
          campaign: null,
          posts: [],
          assets: [],
          publishItems: [buildPublishItem()],
          calendarEvents: [],
          statuses: buildStatusSummary({
            ready_to_publish: 1,
          }),
        },
      }),
    ],
    reviews: [],
    profile: null,
    integrationCards: [],
  });

  assert.equal(model.workingNow.mode, 'publish');
  assert.equal(model.workingNow.href, '/dashboard/posts');
  assert.equal(model.workingNow.items.length, 1);
  assert.match(model.workingNow.summary, /publish-ready items/i);
});

test('the dashboard home view-model builds from plain runtime inputs without demo fixtures', () => {
  const model = createDashboardHomeViewModel({
    campaigns: [],
    reviews: [],
    profile: null,
    integrationCards: [],
  });

  assert.equal(model.hero.title, 'Your business');
  assert.equal(model.nextAction.href, '/onboarding/start');
  assert.equal(model.workingNow.mode, 'waiting');
  assert.deepEqual(model.results.items, []);
});
