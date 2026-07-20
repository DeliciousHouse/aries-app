import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimePostListItem, ScheduledPostItem } from '../lib/api/aries-v1';
import { createCalendarViewModel } from '../frontend/aries-v1/view-models/calendar';

/**
 * A1 / T11 regression — the calendar grid is fed by `scheduled_posts`, not the
 * runtime `dashboard.calendarEvents`; the campaign strip still comes from the
 * runtime campaigns. Day keys are tenant-zone aware (C1).
 */

function buildScheduledPost(overrides: Partial<ScheduledPostItem> = {}): ScheduledPostItem {
  return {
    id: '901',
    postId: '42',
    jobId: 'job-1',
    tenantId: 7,
    title: 'Launch carousel',
    caption: 'Launch carousel\nbody copy',
    platform: 'facebook',
    targetPlatforms: ['facebook', 'instagram'],
    scheduledFor: '2026-04-15T14:00:00.000Z',
    dispatchStatus: 'pending',
    dispatchedAt: null,
    errorAt: null,
    errorMessage: null,
    updatedAt: '2026-04-01T00:00:00.000Z',
    dispatches: [],
    ...overrides,
  };
}

function buildCampaign(overrides: Partial<RuntimePostListItem> = {}): RuntimePostListItem {
  return {
    id: 'campaign-1',
    jobId: 'job-1',
    name: 'Spring Launch',
    objective: 'Drive bookings',
    funnelStage: 'Conversion',
    status: 'scheduled',
    dashboardStatus: 'scheduled',
    executionState: 'completed',
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
      post: null,
      posts: [],
      assets: [],
      publishItems: [],
      calendarEvents: [],
      statuses: {
        countsByStatus: {
          draft: 0,
          in_review: 0,
          ready: 0,
          ready_to_publish: 0,
          published_to_meta_paused: 0,
          scheduled: 0,
          live: 0,
        },
      },
    },
    ...overrides,
  };
}

test('calendar view-model maps scheduled_posts rows into grid events', () => {
  const model = createCalendarViewModel({
    scheduledPosts: [
      buildScheduledPost({ id: '901', scheduledFor: '2026-04-15T14:00:00.000Z' }),
      buildScheduledPost({
        id: '902',
        postId: '43',
        scheduledFor: '2026-04-20T16:30:00.000Z',
        dispatchStatus: 'dispatched',
      }),
    ],
    posts: [buildCampaign()],
    timeZone: 'America/New_York',
  });

  assert.equal(model.events.length, 2);
  // Day keys are computed in the tenant zone (America/New_York).
  assert.deepEqual(
    model.events.map((event) => event.dayKey),
    ['2026-04-15', '2026-04-20'],
  );
  assert.equal(model.events[0].dispatchStatus, 'pending');
  assert.equal(model.events[1].dispatchStatus, 'dispatched');
  assert.match(model.events[0].scheduledFor, /Apr 15/);
  assert.match(model.events[0].scheduledFor, /10:00 AM EDT/);
  assert.doesNotMatch(model.events[0].scheduledFor, /UTC/);
});

test('calendar view-model day key is tenant-zone aware (11pm post lands on the tenant day)', () => {
  // 2026-04-16T03:00:00Z is 2026-04-15 23:00 in New York.
  const model = createCalendarViewModel({
    scheduledPosts: [buildScheduledPost({ scheduledFor: '2026-04-16T03:00:00.000Z' })],
    posts: [],
    timeZone: 'America/New_York',
  });
  assert.equal(model.events[0].dayKey, '2026-04-15');

  // The same instant in Tokyo is Apr 16.
  const tokyoModel = createCalendarViewModel({
    scheduledPosts: [buildScheduledPost({ scheduledFor: '2026-04-16T03:00:00.000Z' })],
    posts: [],
    timeZone: 'Asia/Tokyo',
  });
  assert.equal(tokyoModel.events[0].dayKey, '2026-04-16');
});

test('calendar view-model keeps the campaign strip fed by runtime campaigns', () => {
  const model = createCalendarViewModel({
    scheduledPosts: [],
    posts: [buildCampaign({ name: 'Spring Launch' })],
    timeZone: 'UTC',
  });
  assert.equal(model.posts.length, 1);
  assert.equal(model.posts[0].name, 'Spring Launch');
  assert.equal(model.posts[0].href, '/dashboard/social-content/campaign-1');
  // No scheduled posts -> empty grid (intentional A1 consequence).
  assert.equal(model.events.length, 0);
});

test('calendar glance marks a failed runtime job and links to its failure details', () => {
  const model = createCalendarViewModel({
    scheduledPosts: [],
    posts: [
      buildCampaign({
        status: 'draft',
        dashboardStatus: 'draft',
        executionState: 'failed',
        stageLabel: 'research',
        pendingApprovals: 0,
      }),
    ],
    timeZone: 'UTC',
  });

  assert.equal(model.posts[0].failed, true);
  assert.equal(model.posts[0].failureLabel, 'Research failed');
  assert.equal(model.posts[0].actionLabel, 'View failure details');
  assert.equal(model.posts[0].href, '/dashboard/social-content/campaign-1');
});

test('calendar view-model surfaces the unscheduled backlog tray', () => {
  const model = createCalendarViewModel({
    scheduledPosts: [],
    posts: [],
    unscheduledPosts: [
      {
        postId: '77',
        jobId: 'job-9',
        title: 'Approved but unscheduled',
        caption: 'Approved but unscheduled',
        platform: 'instagram',
        imageUrl: null,
        href: '/dashboard/social-content/job-9',
      },
    ],
    timeZone: 'UTC',
  });
  assert.equal(model.unscheduled.length, 1);
  assert.equal(model.unscheduled[0].postId, '77');
  // The hero metric reflects the backlog count.
  const backlogMetric = model.hero.metrics.find((metric) => metric.label === 'Awaiting backlog');
  assert.equal(backlogMetric?.value, '1');
});

test('calendar view-model carries the resolved timezone through to the model', () => {
  const model = createCalendarViewModel({
    scheduledPosts: [],
    posts: [],
    timeZone: 'America/Chicago',
  });
  assert.equal(model.timeZone, 'America/Chicago');
});
