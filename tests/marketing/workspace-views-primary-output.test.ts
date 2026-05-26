import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  primaryOutputToCampaignPlanner,
  primaryOutputToProductionPreview,
} from '../../backend/marketing/workspace-views';
import { resolveStageOutput } from '../../backend/marketing/runtime-state';
import type { MarketingJobRuntimeDocument } from '../../backend/marketing/runtime-state';

async function loadFixture(): Promise<MarketingJobRuntimeDocument> {
  const fixturePath = path.resolve('tests/fixtures/marketing-runtime-primary-output.json');
  const raw = JSON.parse(await readFile(fixturePath, 'utf8'));
  return raw as MarketingJobRuntimeDocument;
}

// ---------------------------------------------------------------------------
// Adapter: primaryOutputToCampaignPlanner
// ---------------------------------------------------------------------------

test('primaryOutputToCampaignPlanner: maps positioning to campaign_plan.core_message', async () => {
  const doc = await loadFixture();
  const strategyOutput = resolveStageOutput(doc, 'strategy');
  assert.ok(strategyOutput, 'strategy primary_output should resolve');

  const planner = primaryOutputToCampaignPlanner(strategyOutput);
  const campaignPlan = planner.campaign_plan as Record<string, unknown>;

  assert.ok(
    typeof campaignPlan.core_message === 'string' && (campaignPlan.core_message as string).length > 0,
    'core_message should be non-empty string from positioning',
  );
  assert.ok(
    (campaignPlan.core_message as string).includes('calm weekly social content'),
    'core_message should contain positioning text',
  );
});

test('primaryOutputToCampaignPlanner: channel_adaptation → channel_plans[] with platform+instructions', async () => {
  const doc = await loadFixture();
  const strategyOutput = resolveStageOutput(doc, 'strategy');
  assert.ok(strategyOutput);

  const planner = primaryOutputToCampaignPlanner(strategyOutput);
  const campaignPlan = planner.campaign_plan as Record<string, unknown>;
  const channelPlans = campaignPlan.channel_plans as Array<{ platform: string; instructions: unknown }>;

  assert.ok(Array.isArray(channelPlans), 'channel_plans should be an array');
  assert.ok(channelPlans.length >= 2, 'should have at least 2 channel plans (instagram, facebook)');

  const platforms = channelPlans.map((p) => p.platform);
  assert.ok(platforms.includes('instagram'), 'should include instagram');
  assert.ok(platforms.includes('facebook'), 'should include facebook');
  for (const plan of channelPlans) {
    assert.ok(typeof plan.instructions === 'string' && plan.instructions.length > 0, `instructions non-empty for ${plan.platform}`);
  }
});

test('primaryOutputToCampaignPlanner: content_package[] is passed through with 7 posts', async () => {
  const doc = await loadFixture();
  const strategyOutput = resolveStageOutput(doc, 'strategy');
  assert.ok(strategyOutput);

  const planner = primaryOutputToCampaignPlanner(strategyOutput);
  const campaignPlan = planner.campaign_plan as Record<string, unknown>;
  const contentPackage = campaignPlan.content_package as Array<Record<string, unknown>>;

  assert.ok(Array.isArray(contentPackage), 'content_package should be an array');
  assert.equal(contentPackage.length, 7, 'should have exactly 7 posts');
});

test('primaryOutputToCampaignPlanner: all 7 posts have hook, body, cta', async () => {
  const doc = await loadFixture();
  const strategyOutput = resolveStageOutput(doc, 'strategy');
  assert.ok(strategyOutput);

  const planner = primaryOutputToCampaignPlanner(strategyOutput);
  const campaignPlan = planner.campaign_plan as Record<string, unknown>;
  const contentPackage = campaignPlan.content_package as Array<Record<string, unknown>>;

  for (const [i, post] of contentPackage.entries()) {
    assert.ok(typeof post.hook === 'string' && post.hook.length > 0, `post ${i + 1} hook missing`);
    assert.ok(typeof post.body === 'string' && post.body.length > 0, `post ${i + 1} body missing`);
    assert.ok(typeof post.cta === 'string' && post.cta.length > 0, `post ${i + 1} cta missing`);
  }
});

test('primaryOutputToCampaignPlanner: creative_direction is preserved at top level', async () => {
  const doc = await loadFixture();
  const strategyOutput = resolveStageOutput(doc, 'strategy');
  assert.ok(strategyOutput);

  const planner = primaryOutputToCampaignPlanner(strategyOutput);
  assert.ok(
    typeof planner.creative_direction === 'string' && (planner.creative_direction as string).length > 0,
    'creative_direction should be non-empty string',
  );
  assert.ok(
    (planner.creative_direction as string).includes('B2B SaaS'),
    'creative_direction should contain verbatim text from fixture',
  );
});

test('primaryOutputToCampaignPlanner: does not map creative_direction to objective (D2)', async () => {
  const doc = await loadFixture();
  const strategyOutput = resolveStageOutput(doc, 'strategy');
  assert.ok(strategyOutput);

  const planner = primaryOutputToCampaignPlanner(strategyOutput);
  const campaignPlan = planner.campaign_plan as Record<string, unknown>;
  assert.equal(campaignPlan.objective, undefined, 'objective must be absent (D2: no filler mapping)');
});

// ---------------------------------------------------------------------------
// Adapter: primaryOutputToProductionPreview
// ---------------------------------------------------------------------------

test('primaryOutputToProductionPreview: wraps content_package in production_handoff.production_brief', async () => {
  const doc = await loadFixture();
  const productionOutput = resolveStageOutput(doc, 'production');
  assert.ok(productionOutput);

  const preview = primaryOutputToProductionPreview(productionOutput);
  const handoff = preview.production_handoff as Record<string, unknown>;
  const brief = handoff.production_brief as Record<string, unknown>;

  assert.ok(Array.isArray(brief.content_package), 'production_brief.content_package should be an array');
  assert.ok((brief.content_package as unknown[]).length > 0, 'content_package should have posts');
});

test('primaryOutputToProductionPreview: weekly_content_plan preserved', async () => {
  const doc = await loadFixture();
  const productionOutput = resolveStageOutput(doc, 'production');
  assert.ok(productionOutput);

  const preview = primaryOutputToProductionPreview(productionOutput);
  const handoff = preview.production_handoff as Record<string, unknown>;
  const brief = handoff.production_brief as Record<string, unknown>;

  assert.ok(brief.weekly_plan !== null && brief.weekly_plan !== undefined, 'weekly_plan should be set from weekly_content_plan');
});

// ---------------------------------------------------------------------------
// Regression: legacy outputs.* precedence (D4 IRON RULE)
// ---------------------------------------------------------------------------

test('resolveStageOutput: legacy doc with outputs.campaign_planner_path → outputs wins (IRON RULE)', () => {
  const legacyOutputs = { campaign_planner_path: '/legacy/planner.json' };
  const doc: Partial<MarketingJobRuntimeDocument> = {
    stages: {
      research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: { positioning: 'should not appear' }, outputs: legacyOutputs, artifacts: [], errors: [] },
      production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      publish: { stage: 'publish', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
    },
  };

  const result = resolveStageOutput(doc as MarketingJobRuntimeDocument, 'strategy');
  assert.ok(result, 'should resolve non-null');
  assert.equal(result.campaign_planner_path, '/legacy/planner.json', 'legacy path must survive');
  assert.equal(result.positioning, undefined, 'primary_output must not bleed into result');
});

// ---------------------------------------------------------------------------
// strategyReady gate: fixture has non-empty primary_output → campaignPlanner is set
// ---------------------------------------------------------------------------

test('fixture strategy primary_output resolves and produces non-empty campaign_plan', async () => {
  const doc = await loadFixture();
  const strategyOutput = resolveStageOutput(doc, 'strategy');

  assert.ok(strategyOutput, 'strategy output should resolve (strategyReady gate depends on this)');

  const planner = primaryOutputToCampaignPlanner(strategyOutput);
  const campaignPlan = planner.campaign_plan as Record<string, unknown>;

  // strategyReady = !!payloads.campaignPlanner — this test proves the shim produces a value
  assert.ok(campaignPlan, 'campaign_plan must be non-null (strategyReady === true)');
  assert.ok(
    typeof campaignPlan.core_message === 'string' && campaignPlan.core_message.length > 0,
    'core_message must be non-empty',
  );
});
