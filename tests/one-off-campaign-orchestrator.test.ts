import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOneOffBriefForArgs } from '@/backend/marketing/orchestrator';
import type { MarketingJobRuntimeDocument } from '@/backend/marketing/runtime-state';

// Locks in the one_off_brief assembly so a regression silently dropping the
// countdown or one of the three required fields gets caught before it ships
// to Hermes. days_until_end is computed against Date.now() so we test the
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

test('buildOneOffBriefForArgs returns null for weekly_social_content jobs', () => {
  const doc = baseDoc({ job_type: 'weekly_social_content' });
  assert.equal(buildOneOffBriefForArgs(doc), null);
});

test('buildOneOffBriefForArgs returns null when oneOff payload is missing entirely', () => {
  const doc = baseDoc({ job_type: 'one_off_campaign', inputs: { request: {}, brand_url: '' } });
  assert.equal(buildOneOffBriefForArgs(doc), null);
});

test('buildOneOffBriefForArgs returns null when any required field is missing', () => {
  const partial = baseDoc({
    job_type: 'one_off_campaign',
    inputs: {
      request: {
        oneOff: {
          name: 'Summer Flash Sale',
          campaignEndDate: '2026-06-10T03:59:59.999Z',
          // cta missing
        },
      },
      brand_url: '',
    },
  });
  assert.equal(buildOneOffBriefForArgs(partial), null);
});

test('buildOneOffBriefForArgs returns minimal brief when only required fields present', () => {
  const doc = baseDoc({
    job_type: 'one_off_campaign',
    inputs: {
      request: {
        oneOff: {
          name: 'Summer Flash Sale',
          // Future date so days_until_end is positive and computable.
          campaignEndDate: '2099-06-10T03:59:59.999Z',
          cta: 'Shop the sale',
        },
      },
      brand_url: '',
    },
  });
  const brief = buildOneOffBriefForArgs(doc);
  assert.ok(brief, 'one_off_brief must be present for complete one_off_campaign');
  assert.equal(brief?.name, 'Summer Flash Sale');
  assert.equal(brief?.campaign_end_date, '2099-06-10T03:59:59.999Z');
  assert.equal(brief?.cta, 'Shop the sale');
  assert.equal(typeof brief?.days_until_end, 'number');
  assert.ok((brief?.days_until_end as number) > 365 * 50);
  // Milestone fields stay absent when not provided -- Hermes shouldn't see
  // empty milestone keys.
  assert.equal(brief?.milestone_date, undefined);
  assert.equal(brief?.milestone_label, undefined);
});

test('buildOneOffBriefForArgs surfaces milestone date + label when both present', () => {
  const doc = baseDoc({
    job_type: 'one_off_campaign',
    inputs: {
      request: {
        oneOff: {
          name: 'Aries AI Hackathon',
          campaignEndDate: '2099-06-14T03:59:59.999Z',
          cta: 'Register at example.com/hackathon',
          milestoneDate: '2099-06-10T03:59:59.999Z',
          milestoneLabel: 'Registration deadline',
        },
      },
      brand_url: '',
    },
  });
  const brief = buildOneOffBriefForArgs(doc);
  assert.ok(brief);
  assert.equal(brief?.milestone_date, '2099-06-10T03:59:59.999Z');
  assert.equal(brief?.milestone_label, 'Registration deadline');
});

test('buildOneOffBriefForArgs drops orphan milestone (date without label or vice versa)', () => {
  const dateOnly = baseDoc({
    job_type: 'one_off_campaign',
    inputs: {
      request: {
        oneOff: {
          name: 'Product launch',
          campaignEndDate: '2099-06-14T03:59:59.999Z',
          cta: 'Pre-order now',
          milestoneDate: '2099-06-10T03:59:59.999Z',
          // label missing
        },
      },
      brand_url: '',
    },
  });
  const brief1 = buildOneOffBriefForArgs(dateOnly);
  assert.ok(brief1);
  assert.equal(brief1?.milestone_date, undefined, 'orphan milestone date must not leak to Hermes');

  const labelOnly = baseDoc({
    job_type: 'one_off_campaign',
    inputs: {
      request: {
        oneOff: {
          name: 'Product launch',
          campaignEndDate: '2099-06-14T03:59:59.999Z',
          cta: 'Pre-order now',
          milestoneLabel: 'Launch day',
          // date missing
        },
      },
      brand_url: '',
    },
  });
  const brief2 = buildOneOffBriefForArgs(labelOnly);
  assert.ok(brief2);
  assert.equal(brief2?.milestone_label, undefined, 'orphan milestone label must not leak to Hermes');
});

test('days_until_end clamps to 0 for a passed end date', () => {
  const doc = baseDoc({
    job_type: 'one_off_campaign',
    inputs: {
      request: {
        oneOff: {
          name: 'Already-finished campaign',
          campaignEndDate: '2000-01-01T00:00:00.000Z',
          cta: 'Visit example.com',
        },
      },
      brand_url: '',
    },
  });
  const brief = buildOneOffBriefForArgs(doc);
  assert.ok(brief);
  assert.equal(brief?.days_until_end, 0);
});

test('buildOneOffBriefForArgs returns null when oneOff field is not an object', () => {
  const malformed = baseDoc({
    job_type: 'one_off_campaign',
    inputs: { request: { oneOff: 'oops' }, brand_url: '' },
  });
  assert.equal(buildOneOffBriefForArgs(malformed), null);
});
