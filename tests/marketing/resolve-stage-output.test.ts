import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStageOutput } from '../../backend/marketing/runtime-state';
import type { SocialContentJobRuntimeDocument, MarketingStage } from '../../backend/marketing/runtime-state';

function makeStage(opts: { outputs?: Record<string, unknown>; primary_output?: Record<string, unknown> | null } = {}) {
  return {
    stage: 'strategy' as const,
    status: 'completed' as const,
    started_at: null,
    completed_at: null,
    failed_at: null,
    run_id: null,
    summary: null,
    primary_output: opts.primary_output ?? null,
    outputs: opts.outputs ?? {},
    artifacts: [],
    errors: [],
  };
}

function makeDoc(stages: Partial<Record<MarketingStage, ReturnType<typeof makeStage>>>): SocialContentJobRuntimeDocument {
  const ts = new Date().toISOString();
  const base = makeStage();
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: 'job_test_rso',
    tenant_id: '1',
    job_type: 'weekly_social_content',
    state: 'completed',
    status: 'completed',
    current_stage: 'publish',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: stages.research ?? { ...base, stage: 'research' },
      strategy: stages.strategy ?? { ...base, stage: 'strategy' },
      production: stages.production ?? { ...base, stage: 'production' },
      publish: stages.publish ?? { ...base, stage: 'publish' },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      source_url: 'https://example.com',
      canonical_url: 'https://example.com',
      brand_name: 'Test',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: ts,
      brand_voice_summary: null,
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
      path: '/tmp/brand-kit.json',
    },
    inputs: { request: {}, brand_url: 'https://example.com' },
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
  };
}

// T1: outputs-wins — non-empty outputs takes precedence over primary_output
test('resolveStageOutput: non-empty outputs wins over primary_output', () => {
  const doc = makeDoc({
    strategy: makeStage({
      outputs: { campaign_planner_path: '/path/to/planner.json' },
      primary_output: { positioning: 'should not appear' },
    }),
  });
  const result = resolveStageOutput(doc, 'strategy');
  assert.ok(result, 'should return non-null');
  assert.equal(result.campaign_planner_path, '/path/to/planner.json');
  assert.equal(result.positioning, undefined, 'primary_output fields must not appear when outputs wins');
});

// T1: primary_output fallback — empty outputs falls through to primary_output
test('resolveStageOutput: empty outputs falls back to primary_output', () => {
  const doc = makeDoc({
    strategy: makeStage({
      outputs: {},
      primary_output: { positioning: 'Aries AI is the calm weekly content OS' },
    }),
  });
  const result = resolveStageOutput(doc, 'strategy');
  assert.ok(result, 'should return non-null');
  assert.equal(result.positioning, 'Aries AI is the calm weekly content OS');
});

// T1: both-empty returns null
test('resolveStageOutput: both outputs and primary_output empty returns null', () => {
  const doc = makeDoc({
    strategy: makeStage({ outputs: {}, primary_output: null }),
  });
  const result = resolveStageOutput(doc, 'strategy');
  assert.equal(result, null);
});

// T1: primary_output empty object also returns null (zero-length primary_output treated as absent)
test('resolveStageOutput: empty primary_output object returns null', () => {
  const doc = makeDoc({
    strategy: makeStage({ outputs: {}, primary_output: {} }),
  });
  const result = resolveStageOutput(doc, 'strategy');
  assert.equal(result, null);
});

// T1: works for all 4 stage names
for (const stage of ['research', 'strategy', 'production', 'publish'] as const) {
  test(`resolveStageOutput: works for stage=${stage}`, () => {
    const doc = makeDoc({
      [stage]: makeStage({ outputs: {}, primary_output: { test_field: stage } }),
    } as Partial<Record<MarketingStage, ReturnType<typeof makeStage>>>);
    const result = resolveStageOutput(doc, stage);
    assert.ok(result, `expected non-null for stage=${stage}`);
    assert.equal(result.test_field, stage);
  });
}
