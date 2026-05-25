import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWeeklySnapshotPathForTests,
  buildOneOffCampaignWindowForTests,
} from '@/backend/marketing/jobs-status';
import { buildSocialContentDashboardProjection } from '@/backend/social-content/dashboard-projection';
import type { MarketingJobRuntimeDocument } from '@/backend/marketing/runtime-state';
import type { MarketingDashboardCampaignContent } from '@/backend/marketing/dashboard-content';

// Regression test for v0.1.11.2:
// A one_off_campaign with inputs.request.oneOff.campaignEndDate must surface
// that date as the campaign window end -- not a synthetically derived
// today+6d weekly window. The bug was that isWeeklySocialContent was always
// true (requestedJobTypeFromDoc is hardcoded to 'weekly_social_content' so
// one_off campaigns ride the weekly Hermes pipeline by design), causing
// buildWeeklyCalendarSnapshot to override the authoritative end date.

const ONE_OFF_END_DATE = '2026-09-15T03:59:59.000Z';

function baseDoc(overrides: Partial<MarketingJobRuntimeDocument> = {}): MarketingJobRuntimeDocument {
  return {
    schema_name: 'aries.marketing.job.runtime' as MarketingJobRuntimeDocument['schema_name'],
    schema_version: '1.0.0' as MarketingJobRuntimeDocument['schema_version'],
    job_id: 'job-one-off-window-regression',
    tenant_id: 'tenant-42',
    job_type: 'one_off_campaign',
    state: 'queued',
    status: 'pending',
    current_stage: 'research',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { state: 'pending', status: 'pending', started_at: null, finished_at: null, artifacts: [], notes: [] },
      strategy: { state: 'pending', status: 'pending', started_at: null, finished_at: null, artifacts: [], notes: [] },
      production: { state: 'pending', status: 'pending', started_at: null, finished_at: null, artifacts: [], notes: [] },
      publish: { state: 'pending', status: 'pending', started_at: null, finished_at: null, artifacts: [], notes: [] },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], livePublishPlatforms: [], videoRenderPlatforms: [] },
    brand_kit: null,
    inputs: {
      brand_url: 'https://brand.example',
      request: {
        jobType: 'one_off_campaign',
        oneOff: {
          name: 'Summer Flash Sale',
          campaignEndDate: ONE_OFF_END_DATE,
          cta: 'Shop the sale',
        },
      },
    },
    ...overrides,
  } as MarketingJobRuntimeDocument;
}

function emptyDashboard(): MarketingDashboardCampaignContent {
  return {
    campaign: null,
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
  };
}

test('one_off_campaign doc does not enter the weekly snapshot path', () => {
  const doc = baseDoc();
  assert.equal(isWeeklySnapshotPathForTests(doc), false,
    'one_off_campaign must be excluded from the weekly calendar snapshot path');
});

test('weekly_social_content doc still enters the weekly snapshot path', () => {
  const doc = baseDoc({ job_type: 'weekly_social_content' });
  assert.equal(isWeeklySnapshotPathForTests(doc), true,
    'weekly_social_content must continue to use the weekly snapshot path');
});

test('buildOneOffCampaignWindowForTests surfaces the authoritative campaignEndDate', () => {
  const doc = baseDoc();
  const window = buildOneOffCampaignWindowForTests(doc);
  assert.ok(window !== null, 'window must not be null for a valid one_off_campaign');
  assert.equal(window.end, ONE_OFF_END_DATE,
    'campaign window end must equal the operator-provided campaignEndDate, not a weekly default');
});

test('buildOneOffCampaignWindowForTests returns null for weekly_social_content docs', () => {
  const doc = baseDoc({ job_type: 'weekly_social_content' });
  assert.equal(buildOneOffCampaignWindowForTests(doc), null,
    'weekly docs must not produce a one-off window');
});

test('buildSocialContentDashboardProjection returns dashboard unchanged for one_off_campaign', () => {
  const doc = baseDoc();
  const dashboard = emptyDashboard();
  const result = buildSocialContentDashboardProjection(doc, dashboard);
  // The guard at the top of buildSocialContentDashboardProjection checks
  // requestedJobTypeFromDoc which reads inputs.request.jobType -- for one_off
  // docs that returns 'one_off_campaign', so the function returns early without
  // overriding any campaign window data.
  assert.equal(result, dashboard, 'dashboard must be returned unchanged for one_off_campaign');
});
