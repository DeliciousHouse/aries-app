import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEventBriefForArgs } from '@/backend/marketing/orchestrator';
import type { MarketingJobRuntimeDocument } from '@/backend/marketing/runtime-state';

// T8: lock in the event_brief assembly so a regression silently dropping the
// countdown or one of the five required fields gets caught before it ships to
// Hermes. days_until_deadline is computed against Date.now() so we test the
// shape and the deadline math separately.

function baseDoc(overrides: Partial<MarketingJobRuntimeDocument> = {}): MarketingJobRuntimeDocument {
  return {
    schema_name: 'aries.marketing.job.runtime' as MarketingJobRuntimeDocument['schema_name'],
    schema_version: '1.0.0' as MarketingJobRuntimeDocument['schema_version'],
    job_id: 'job-1',
    tenant_id: '42',
    job_type: 'weekly_social_content',
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
      request: {},
      brand_url: '',
    },
    ...overrides,
  } as MarketingJobRuntimeDocument;
}

test('buildEventBriefForArgs returns null for weekly_social_content jobs', () => {
  const doc = baseDoc({ job_type: 'weekly_social_content' });
  assert.equal(buildEventBriefForArgs(doc), null);
});

test('buildEventBriefForArgs returns null when event payload is missing entirely', () => {
  const doc = baseDoc({ job_type: 'event_campaign', inputs: { request: {}, brand_url: '' } });
  assert.equal(buildEventBriefForArgs(doc), null);
});

test('buildEventBriefForArgs returns null when any required event field is missing', () => {
  const partial = baseDoc({
    job_type: 'event_campaign',
    inputs: {
      request: {
        event: {
          eventName: 'Aries AI Hackathon',
          eventDate: '2026-06-10T06:59:59.999Z',
          registrationDeadline: '2026-06-10T06:59:59.999Z',
          campaignEndDate: '2026-06-10T06:59:59.999Z',
          // cta missing
        },
      },
      brand_url: '',
    },
  });
  assert.equal(buildEventBriefForArgs(partial), null);
});

test('buildEventBriefForArgs returns the structured Hermes payload when complete', () => {
  const doc = baseDoc({
    job_type: 'event_campaign',
    inputs: {
      request: {
        event: {
          eventName: 'Aries AI Hackathon',
          // Future date so days_until_deadline is positive and computable.
          eventDate: '2099-06-10T06:59:59.999Z',
          registrationDeadline: '2099-06-10T06:59:59.999Z',
          campaignEndDate: '2099-06-10T06:59:59.999Z',
          cta: 'Register at aries.example.com/hackathon',
        },
      },
      brand_url: '',
    },
  });
  const brief = buildEventBriefForArgs(doc);
  assert.ok(brief, 'event_brief must be present for complete event_campaign');
  assert.equal(brief?.event_name, 'Aries AI Hackathon');
  assert.equal(brief?.event_date, '2099-06-10T06:59:59.999Z');
  assert.equal(brief?.registration_deadline, '2099-06-10T06:59:59.999Z');
  assert.equal(brief?.campaign_end_date, '2099-06-10T06:59:59.999Z');
  assert.equal(brief?.cta, 'Register at aries.example.com/hackathon');
  // days_until_deadline is computed; for a 2099 date it must be a large
  // positive integer. The exact value depends on wall-clock time, but the
  // contract -- "non-negative integer for a future deadline" -- is testable.
  assert.equal(typeof brief?.days_until_deadline, 'number');
  assert.ok((brief?.days_until_deadline as number) > 365 * 50);
});

test('days_until_deadline clamps to 0 for a passed deadline', () => {
  const doc = baseDoc({
    job_type: 'event_campaign',
    inputs: {
      request: {
        event: {
          eventName: 'Already-finished event',
          eventDate: '2000-01-01T00:00:00.000Z',
          registrationDeadline: '2000-01-01T00:00:00.000Z',
          campaignEndDate: '2000-01-01T00:00:00.000Z',
          cta: 'Visit aries.example.com',
        },
      },
      brand_url: '',
    },
  });
  const brief = buildEventBriefForArgs(doc);
  assert.ok(brief);
  assert.equal(brief?.days_until_deadline, 0);
});

test('buildEventBriefForArgs returns null when event field is not an object', () => {
  const malformed = baseDoc({
    job_type: 'event_campaign',
    inputs: { request: { event: 'oops' }, brand_url: '' },
  });
  assert.equal(buildEventBriefForArgs(malformed), null);
});
