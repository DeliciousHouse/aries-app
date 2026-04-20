import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AriesDashboardCalendarEvent,
  AriesDashboardStatusSummary,
  RuntimeCampaignListItem,
} from '../lib/api/aries-v1';
import { createCalendarViewModel } from '../frontend/aries-v1/view-models/calendar';

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

function buildCalendarEvent(
  overrides: Partial<AriesDashboardCalendarEvent> = {},
): AriesDashboardCalendarEvent {
  return {
    id: 'event-1',
    campaignId: 'campaign-1',
    jobId: 'job-1',
    title: 'Launch carousel',
    platform: 'meta',
    platformLabel: 'Meta Ads',
    startsAt: '2026-04-15T14:00:00.000Z',
    endsAt: null,
    status: 'scheduled',
    statusLabel: 'Scheduled',
    campaignName: 'Spring Launch',
    funnelStage: 'Conversion',
    objective: 'Drive bookings',
    destinationUrl: 'https://example.com/book',
    previewAssetId: null,
    sourcePostId: null,
    sourcePublishItemId: null,
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
    jobId: 'job-1',
    name: 'Spring Launch',
    objective: 'Drive bookings',
    funnelStage: 'Conversion',
    status: 'scheduled',
    dashboardStatus: 'scheduled',
    stageLabel: 'publish',
    summary: 'Launch the seasonal offer.',
    dateRange: 'Apr 15 - Apr 30',
    pendingApprovals: 0,
    nextScheduled: '2026-04-15T14:00:00.000Z · Meta Ads',
    trustNote: 'Nothing goes live without approval.',
    updatedAt: '2026-04-01T00:00:00.000Z',
    approvalRequired: false,
    counts: {
      posts: 1,
      landingPages: 0,
      imageAds: 1,
      videoAds: 0,
      scripts: 0,
      publishItems: 1,
      proposalConcepts: 0,
      ready: 0,
      readyToPublish: 0,
      pausedMetaAds: 0,
      scheduled: 1,
      live: 0,
    },
    previewPosts: [],
    previewAssets: [],
    dashboard: {
      campaign: null,
      posts: [],
      assets: [],
      publishItems: [],
      calendarEvents: [buildCalendarEvent()],
      statuses: buildStatusSummary({
        scheduled: 1,
      }),
    },
    ...overrides,
  };
}

test('calendar view-model uses runtime calendar events for the month grid', () => {
  const model = createCalendarViewModel([
    buildCampaign({
      dashboard: {
        campaign: null,
        posts: [],
        assets: [],
        publishItems: [],
        calendarEvents: [
          buildCalendarEvent({
            id: 'event-1',
            title: 'Launch carousel',
            startsAt: '2026-04-15T14:00:00.000Z',
          }),
          buildCalendarEvent({
            id: 'event-2',
            title: 'Retargeting refresh',
            startsAt: '2026-04-20T16:30:00.000Z',
            status: 'live',
            statusLabel: 'Live',
          }),
        ],
        statuses: buildStatusSummary({
          scheduled: 1,
          live: 1,
        }),
      },
    }),
  ]);

  assert.equal(model.events.length, 2);
  assert.deepEqual(
    model.events.map((event) => event.dayKey),
    ['2026-04-15', '2026-04-20'],
  );
  assert.equal(model.events[0].href, '/dashboard/campaigns/campaign-1');
  assert.match(model.events[0].scheduledFor, /Spring Launch/);
  assert.equal(model.hero.metrics[0]?.value, '2');
});

test('calendar view-model relabels landing page events as Reddit', () => {
  const model = createCalendarViewModel([
    buildCampaign({
      dashboard: {
        campaign: null,
        posts: [],
        assets: [],
        publishItems: [],
        calendarEvents: [
          buildCalendarEvent({
            id: 'event-reddit-1',
            platform: 'landing-page',
            platformLabel: 'Landing Page',
          }),
        ],
        statuses: buildStatusSummary({
          scheduled: 1,
        }),
      },
    }),
  ]);

  assert.equal(model.events[0]?.platform, 'Reddit');
});
