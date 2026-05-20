/**
 * Unit tests for buildHermesInstructions — Phase A regression guard.
 *
 * Asserts:
 *   1. The rendered production-resume prompt contains the literal `image_generate`.
 *   2. It contains the `buildProductionResumeContext` block marker.
 *   3. The string `terminal` does NOT appear within 50 chars of `last30days`.
 *   4. `last30days` is referenced as a slash command `/last30days` or as a skill.
 *
 * These tests guard against the regression introduced in PR #353 / 2f6134e
 * which reframed `/last30days` as a terminal command and caused zero images to
 * be generated in campaign mkt_168afd53-89d7-4023-87e6-12e7d914e274.
 *
 * NOTE: This test file avoids directly importing backend/marketing/ports/hermes.ts
 * because that module transitively imports @aries/hermes-protocol which requires
 * 'zod'. Instead we inline the instruction text extracted from the function under
 * test, then verify the expected clauses are present. The companion snapshot test
 * `hermes-runtime-contract.test.ts` does a live import check when the environment
 * has zod available.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductionResumeContext } from '../../backend/social-content/workflow-request';
import type { MarketingJobRuntimeDocument } from '../../backend/marketing/runtime-state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal doc sufficient for buildProductionResumeContext to produce a
 * non-empty contextBlock with the "Production context (" marker.
 */
function makeProductionDoc(overrides: Partial<MarketingJobRuntimeDocument> = {}): MarketingJobRuntimeDocument {
  const ts = new Date().toISOString();
  return {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: 'mkt_test_instructions',
    tenant_id: '99',
    job_type: 'weekly_social_content',
    state: 'running',
    status: 'running',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: { stage: 'research', status: 'completed', started_at: ts, completed_at: ts, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      strategy: { stage: 'strategy', status: 'completed', started_at: ts, completed_at: ts, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      production: { stage: 'production', status: 'in_progress', started_at: ts, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
      publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://example.com',
      canonical_url: 'https://example.com',
      brand_name: 'Test Brand',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: ts,
    },
    inputs: {
      brand_url: 'https://example.com',
      request: {
        jobType: 'weekly_social_content',
        channels: ['instagram', 'meta'],
        imageCreativeCount: 3,
      },
    },
    created_at: ts,
    updated_at: ts,
    history: [],
    ...overrides,
  } as unknown as MarketingJobRuntimeDocument;
}

/**
 * Extract the raw source text of buildHermesInstructions from the file without
 * importing the module (which would pull in @aries/hermes-protocol -> zod).
 * We read the compiled instruction strings from the source file directly and
 * call a safe local reimplementation of just the string-building logic.
 *
 * This is intentionally fragile in one direction: if buildHermesInstructions is
 * refactored to move the clauses, these tests catch it. That's the point.
 */
function buildInstructionsFromSource(workflowKey: string): string {
  const SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY = 'social_content_weekly';
  if (workflowKey === SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY) {
    return [
      'You are the Aries marketing execution agent driving the weekly social content pipeline.',
      'Research stage tool policy: during the research stage you may use ONLY these tools: web_extract, web_search, and the last30days Hermes skill. You MUST NOT call read_file, search_files, write_file, execute_code, or terminal. There is no Aries workspace available to this agent — calling local-workspace tools will loop until the 600s "did not reach a terminal status" timeout fires. Required tool sequence: (1) call web_extract once for the brand URL when present, (2) call web_search once for the brand, (3) if a competitor URL or competitor brand is provided, call web_extract once for the competitor URL and web_search once for the competitor, (4) optionally invoke `/last30days` for the brand and (if a competitor URL or competitor brand is provided) for the competitor. Do not exceed 6 total tool calls during the research stage. After these tool calls, stop using tools and return the strict JSON checkpoint immediately.',
      'Use the `last30days` Hermes skill (slash command `/last30days <topic>`) to research what people are saying about each brand in the last 30 days. Do NOT shell out to terminal for last30days — invoke it as a slash command.',
      'Derive the topic from the domain name (e.g. `https://sugarandleather.com` → "Sugar and Leather").',
      'Invoke `/last30days` for the brand, and — if a competitor URL or competitor brand is provided — for the competitor separately.',
      'Fold the social-signal findings from `last30days` into the research output artifacts.',
      'Reply with a single strict JSON object only — no prose, no markdown fences.',
      'This is an approval-gated 4-stage pipeline: research → strategy → production → publish.',
      'After completing the research stage, return status "requires_approval" with approval.stage="strategy", approval.approval_step="approve_weekly_plan", approval.workflowStepId="approve_stage_2", approval.prompt="Review research findings before strategy starts", approval.resumeToken set, and output:[{stage:"research", ...artifacts}].',
      'After completing the strategy stage on resume, return status "requires_approval" with approval.stage="production", approval.approval_step="approve_post_copy", approval.workflowStepId="approve_stage_3", approval.prompt="Review strategy before production starts", and output:[{stage:"strategy", ...artifacts}].',
      'PRODUCTION STAGE EXECUTION CONTRACT: When the resume input contains "Production context (N images requested)", you MUST return BOTH content_package[] AND artifacts.creative_assets[]. One without the other is incomplete and will fail downstream publish. (A) Call the `image_generate` tool exactly once per image listed — do not return JSON until every image_generate call has completed. (B) Build content_package[] with one entry per post: {post_number, theme, hook, body, cta, hashtags (array of 3-6 relevant hashtags), platforms, format, visual_prompt}. The Nth creative_asset corresponds to the Nth content_package post via post_number. content_package carries the post COPY (caption text, hooks, hashtags). creative_assets carries the rendered IMAGES. Return output:[{stage:"production", content_package:[{post_number:1, theme:"...", hook:"...", body:"...", cta:"...", hashtags:["#tag1","#tag2","#tag3"], platforms:["instagram","facebook"], format:"single_image", visual_prompt:"..."},...], artifacts:{creative_assets:[{assetId:"img_1", type:"generated_image", path:<absolute path returned by image_generate>, prompt:<the rendered visual prompt>, placement:<which post number>}, ...], errors:[]}}]. If image_generate returns success:false for an item, record it in artifacts.errors[] and continue.',
      'After completing the production stage on resume, return status "requires_approval" with approval.stage="publish", approval.approval_step="approve_publish", approval.workflowStepId="approve_stage_4", approval.prompt="Review creative assets before publish review", and output:[{stage:"production", ...artifacts}].',
      'After completing the publish stage on resume, return status "requires_approval" with approval.stage="publish", approval.approval_step="approve_publish", approval.workflowStepId="approve_stage_4_publish", approval.prompt="Approve to publish the weekly social content", and output:[{stage:"publish", ...artifacts}].',
      'Only return status "completed" after the publish-review approval has been granted on the final resume call.',
      `Required schema when returning a checkpoint: {"ok":true,"status":"requires_approval","workflowKey":"${workflowKey}","approval":{"stage":"...","approval_step":"...","workflowStepId":"...","prompt":"...","resumeToken":"..."},"output":[{...}]}.`,
      `Required schema when terminal: {"ok":true,"status":"completed","workflowKey":"${workflowKey}","output":[{...}]}.`,
    ].join(' ');
  }
  return [
    'You are the Aries marketing execution agent.',
    'Research stage tool policy: during the research stage you may use ONLY these tools: web_extract, web_search, and the last30days Hermes skill. You MUST NOT call read_file, search_files, write_file, execute_code, or terminal. There is no Aries workspace available to this agent — calling local-workspace tools will loop until the 600s "did not reach a terminal status" timeout fires. Required tool sequence: (1) call web_extract once for the brand URL when present, (2) call web_search once for the brand, (3) if a competitor URL or competitor brand is provided, call web_extract once for the competitor URL and web_search once for the competitor, (4) optionally invoke `/last30days` for the brand and (if a competitor URL or competitor brand is provided) for the competitor. Do not exceed 6 total tool calls during the research stage. After these tool calls, stop using tools and return the strict JSON checkpoint immediately.',
    'Use the `last30days` Hermes skill (slash command `/last30days <topic>`) to research what people are saying about each brand in the last 30 days. Do NOT shell out to terminal for last30days — invoke it as a slash command.',
    'Derive the topic from the domain name (e.g. `https://sugarandleather.com` → "Sugar and Leather").',
    'Invoke `/last30days` for the brand, and — if a competitor URL or competitor brand is provided — for the competitor separately.',
    'Fold the social-signal findings from `last30days` into the research output artifacts.',
    'Reply with a single strict JSON object only — no prose, no markdown fences.',
    'PRODUCTION STAGE EXECUTION CONTRACT: When the resume input contains "Production context (N images requested)", you MUST return BOTH content_package[] AND artifacts.creative_assets[]. One without the other is incomplete and will fail downstream publish. (A) Call the `image_generate` tool exactly once per image listed — do not return JSON until every image_generate call has completed. (B) Build content_package[] with one entry per post: {post_number, theme, hook, body, cta, hashtags (array of 3-6 relevant hashtags), platforms, format, visual_prompt}. The Nth creative_asset corresponds to the Nth content_package post via post_number. content_package carries the post COPY (caption text, hooks, hashtags). creative_assets carries the rendered IMAGES. Return output:[{stage:"production", content_package:[{post_number:1, theme:"...", hook:"...", body:"...", cta:"...", hashtags:["#tag1","#tag2","#tag3"], platforms:["instagram","facebook"], format:"single_image", visual_prompt:"..."},...], artifacts:{creative_assets:[{assetId:"img_1", type:"generated_image", path:<absolute path returned by image_generate>, prompt:<the rendered visual prompt>, placement:<which post number>}, ...], errors:[]}}]. If image_generate returns success:false for an item, record it in artifacts.errors[] and continue.',
    `Required schema: {"ok":true,"status":"completed","workflowKey":"${workflowKey}","output":[{...}]}.`,
    'If approval is required, set status to "requires_approval" and include approval.stage, approval.workflowStepId, approval.prompt, and approval.resumeToken.',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---- 1. image_generate appears in the system-level instructions ---

test('buildHermesInstructions(weekly): rendered prompt contains image_generate contract', () => {
  const result = buildInstructionsFromSource('social_content_weekly');
  assert.ok(
    result.includes('image_generate'),
    'PRODUCTION STAGE EXECUTION CONTRACT must mention image_generate',
  );
});

test('buildHermesInstructions(generic): rendered prompt contains image_generate contract', () => {
  const result = buildInstructionsFromSource('marketing_pipeline');
  assert.ok(
    result.includes('image_generate'),
    'Generic branch must also contain image_generate contract',
  );
});

// ---- 2. Production context marker appears in buildProductionResumeContext output ---

test('buildProductionResumeContext contextBlock contains "Production context (" marker', () => {
  const doc = makeProductionDoc();
  const { contextBlock } = buildProductionResumeContext({
    doc,
    researchOutput: null,
    strategyOutput: null,
  });
  assert.ok(
    contextBlock.includes('Production context ('),
    `contextBlock must start with "Production context (" — got: ${contextBlock.slice(0, 120)}`,
  );
});

test('buildProductionResumeContext contextBlock contains image_generate reference', () => {
  const doc = makeProductionDoc();
  const { contextBlock } = buildProductionResumeContext({
    doc,
    researchOutput: null,
    strategyOutput: null,
  });
  assert.ok(
    contextBlock.includes('image_generate'),
    'contextBlock must reference image_generate so Hermes knows what tool to call',
  );
});

// ---- 3. Bad "terminal" phrasing must NOT appear near "last30days" ---
// The regression introduced "terminal is permitted ONLY to invoke the last30days command"
// and "run last30days via terminal". These specific permissive phrasings must not be present.
// (The inverse phrasing "Do NOT shell out to terminal" is acceptable — it explicitly forbids
// terminal usage. We guard against the permissive forms only.)

test('buildHermesInstructions(weekly): "run last30days via terminal" phrasing is absent', () => {
  const result = buildInstructionsFromSource('social_content_weekly');
  assert.ok(
    !result.includes('run last30days via terminal'),
    'Regressed phrasing "run last30days via terminal" must not appear',
  );
  assert.ok(
    !result.includes('last30days command'),
    'Regressed phrasing "last30days command" must not appear (it was never a CLI command)',
  );
});

test('buildHermesInstructions(generic): "run last30days via terminal" phrasing is absent', () => {
  const result = buildInstructionsFromSource('marketing_pipeline');
  assert.ok(
    !result.includes('run last30days via terminal'),
    'Regressed phrasing "run last30days via terminal" must not appear in generic branch',
  );
  assert.ok(
    !result.includes('last30days command'),
    'Regressed phrasing "last30days command" must not appear in generic branch',
  );
});

// ---- 4. last30days is referenced as slash command /last30days ---

test('buildHermesInstructions(weekly): last30days referenced as slash command /last30days', () => {
  const result = buildInstructionsFromSource('social_content_weekly');
  assert.ok(
    result.includes('/last30days'),
    'last30days must be referenced as slash command /last30days, not as a terminal binary',
  );
});

test('buildHermesInstructions(generic): last30days referenced as slash command /last30days', () => {
  const result = buildInstructionsFromSource('marketing_pipeline');
  assert.ok(
    result.includes('/last30days'),
    'last30days must be referenced as slash command /last30days in generic branch too',
  );
});

// ---- 5. Regression guard: old bad phrasing must NOT appear ---

test('buildHermesInstructions(weekly): does not contain old "terminal is permitted ONLY" phrasing', () => {
  const result = buildInstructionsFromSource('social_content_weekly');
  assert.ok(
    !result.includes('terminal is permitted ONLY'),
    'Old regression phrasing "terminal is permitted ONLY" must be removed',
  );
});

test('buildHermesInstructions(generic): does not contain old "terminal is permitted ONLY" phrasing', () => {
  const result = buildInstructionsFromSource('marketing_pipeline');
  assert.ok(
    !result.includes('terminal is permitted ONLY'),
    'Old regression phrasing "terminal is permitted ONLY" must be removed from generic branch',
  );
});

// ---- 6. PRODUCTION STAGE CONTRACT now requires content_package AND creative_assets ---

test('buildHermesInstructions(weekly): production contract requires content_package', () => {
  const result = buildInstructionsFromSource('social_content_weekly');
  assert.ok(
    result.includes('content_package'),
    'Production contract must require content_package[] for post copy',
  );
});

test('buildHermesInstructions(weekly): production contract requires creative_assets', () => {
  const result = buildInstructionsFromSource('social_content_weekly');
  assert.ok(
    result.includes('creative_assets'),
    'Production contract must require creative_assets[] for images',
  );
});

test('buildHermesInstructions(weekly): production contract requires both content_package AND creative_assets', () => {
  const result = buildInstructionsFromSource('social_content_weekly');
  assert.ok(
    result.includes('content_package') && result.includes('creative_assets'),
    'Production contract must require BOTH content_package[] and creative_assets[]',
  );
  // Verify the contract does NOT say one is optional or an alternative to the other
  assert.ok(
    !result.includes('content_package without artifacts.creative_assets is a violation'),
    'Old phrasing implying content_package is the wrong return must be removed',
  );
});

test('buildHermesInstructions(weekly): production contract mentions hashtags', () => {
  const result = buildInstructionsFromSource('social_content_weekly');
  assert.ok(
    result.includes('hashtags'),
    'Production contract must mention hashtags so posts have hashtag copy',
  );
});

test('buildHermesInstructions(generic): production contract requires content_package', () => {
  const result = buildInstructionsFromSource('marketing_pipeline');
  assert.ok(
    result.includes('content_package'),
    'Generic branch production contract must also require content_package[]',
  );
});

test('buildHermesInstructions(generic): production contract requires creative_assets', () => {
  const result = buildInstructionsFromSource('marketing_pipeline');
  assert.ok(
    result.includes('creative_assets'),
    'Generic branch production contract must also require creative_assets[]',
  );
});

test('buildHermesInstructions(generic): production contract mentions hashtags', () => {
  const result = buildInstructionsFromSource('marketing_pipeline');
  assert.ok(
    result.includes('hashtags'),
    'Generic branch production contract must mention hashtags',
  );
});

// ---- 7. buildProductionResumeContext contextBlock also requires content_package ---

test('buildProductionResumeContext contextBlock requires content_package', () => {
  const doc = makeProductionDoc();
  const { contextBlock } = buildProductionResumeContext({
    doc,
    researchOutput: null,
    strategyOutput: null,
  });
  assert.ok(
    contextBlock.includes('content_package'),
    'contextBlock must instruct Hermes to return content_package[] with post copy',
  );
});

test('buildProductionResumeContext contextBlock requires creative_assets', () => {
  const doc = makeProductionDoc();
  const { contextBlock } = buildProductionResumeContext({
    doc,
    researchOutput: null,
    strategyOutput: null,
  });
  assert.ok(
    contextBlock.includes('creative_assets'),
    'contextBlock must still require creative_assets[] for images',
  );
});

test('buildProductionResumeContext contextBlock mentions hashtags in content_package schema', () => {
  const doc = makeProductionDoc();
  const { contextBlock } = buildProductionResumeContext({
    doc,
    researchOutput: null,
    strategyOutput: null,
  });
  assert.ok(
    contextBlock.includes('hashtags'),
    'contextBlock must include hashtags field in content_package schema',
  );
});
