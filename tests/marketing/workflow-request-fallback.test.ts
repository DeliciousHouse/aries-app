import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSocialContentWeeklyRequest } from '../../backend/social-content/workflow-request';
import type { MarketingJobRuntimeDocument } from '../../backend/marketing/runtime-state';

const BRAND_URL = 'https://alecferrismusic.com/';
const CALLBACK_URL = 'https://aries.example.com/api/internal/hermes/runs';

function makeDoc(overrides: Partial<MarketingJobRuntimeDocument> = {}): MarketingJobRuntimeDocument {
  const ts = new Date().toISOString();
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: 'job_fallback_test',
    tenant_id: '10',
    job_type: 'brand_campaign',
    state: 'running',
    status: 'running',
    current_stage: 'research',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { stage: 'research', status: 'in_progress', started_at: ts, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      strategy: { stage: 'strategy', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      production: { stage: 'production', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      source_url: BRAND_URL,
      canonical_url: BRAND_URL,
      brand_name: 'Alec Ferris',
      logo_urls: [],
      colors: { primary: '#1a1a2e', secondary: null, accent: null, palette: ['#1a1a2e', '#e94560'] },
      font_families: ['Montserrat'],
      external_links: [
        { platform: 'youtube', url: 'https://youtube.com/@alecferris' },
        { platform: 'instagram', url: 'https://instagram.com/alecferris' },
        { platform: 'tiktok', url: 'https://tiktok.com/@alecferris' },
      ],
      extracted_at: ts,
      brand_voice_summary: 'Alec Ferris is an Alternative/Electronic, Singer-Songwriter originally hailing from the Bay Area, CA. Click here for his new releases and exclusive updates on shows, merch, and behind-the-scenes content.',
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
      path: '/tmp/brand-kit.json',
    },
    inputs: { request: {}, brand_url: BRAND_URL },
    errors: [],
    last_error: null,
    history: [],
    created_at: ts,
    updated_at: ts,
    social_content_runtime: null,
    created_by: null,
    deleted_at: null,
    deleted_by: null,
    soft_cancel_requested_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: businessName falls back to brand_kit.brand_name when operator field is null
// ---------------------------------------------------------------------------

test('businessName falls back to brand_kit.brand_name when operator businessName is absent', () => {
  const doc = makeDoc({ inputs: { request: {}, brand_url: BRAND_URL } });
  const result = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'run_test_001',
    callbackUrl: CALLBACK_URL,
  });

  assert.equal(result.input.brand.name, 'Alec Ferris', 'brand.name must come from brand_kit.brand_name when operator field is absent');
});

// ---------------------------------------------------------------------------
// Test 2: notes falls back to brand_voice_summary (truncated at 300 chars)
// ---------------------------------------------------------------------------

test('notes falls back to brand_voice_summary truncated to 300 chars when operator notes is absent', () => {
  const longSummary = 'A'.repeat(400);
  const doc = makeDoc({
    inputs: { request: {}, brand_url: BRAND_URL },
    brand_kit: {
      source_url: BRAND_URL,
      canonical_url: BRAND_URL,
      brand_name: 'Alec Ferris',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: longSummary,
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
      path: '/tmp/brand-kit.json',
    },
  });

  const result = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'run_test_002',
    callbackUrl: CALLBACK_URL,
  });

  assert.equal(result.input.brand.notes, `${'A'.repeat(300)}…`, 'notes must be truncated at 300 chars with ellipsis');
});

// ---------------------------------------------------------------------------
// Test 3: operator-populated fields take precedence over brand_kit fallbacks
// ---------------------------------------------------------------------------

test('operator businessName and notes take precedence over brand_kit fallbacks', () => {
  const doc = makeDoc({
    inputs: {
      brand_url: BRAND_URL,
      request: {
        businessName: 'Operator Name Override',
        notes: 'Operator notes override',
      },
    },
  });

  const result = buildSocialContentWeeklyRequest({
    doc,
    ariesRunId: 'run_test_003',
    callbackUrl: CALLBACK_URL,
  });

  assert.equal(result.input.brand.name, 'Operator Name Override', 'operator businessName must win over brand_kit.brand_name');
  assert.equal(result.input.brand.notes, 'Operator notes override', 'operator notes must win over brand_voice_summary fallback');
});
