/**
 * tests/marketing/growth-objective.test.ts
 *
 * ITEM 2 — the growth objective + KPI contract (audit F1: "there is no growth
 * objective anywhere in the machine").
 *
 * Three things are pinned here, each because it can break SILENTLY:
 *
 * 1. The default-goal string ↔ `normalizeGoal()` coupling. They are joined by
 *    keyword matching, not by a shared enum, so rewording
 *    DEFAULT_GROWTH_PRIMARY_GOAL can reclassify it (adding "booking" flips it
 *    to lead_generation, "product" to product_sales) and split the Insights
 *    goal card from what the content pipeline optimises for. Nothing else in
 *    the codebase would notice.
 *
 * 2. The KPI contract reaches STRATEGY and PUBLISH and nothing else. Research
 *    is tool-budget constrained, production carries the asset contract, and
 *    publish-finalize is a terminal echo — a KPI paragraph in any of them is
 *    wasted budget at best.
 *
 * 3. The KPI's promises match reality. The subordination clause must exist (a
 *    tenant with an explicit lead-gen goal must not be told followers are the
 *    score), and the engagement definition must match what the performance
 *    block actually reports — likes + comments + shares, saves not collected,
 *    reach only where present. See backend/marketing/performance-context.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHermesStageInstructions,
  GROWTH_OBJECTIVE_KPI,
} from '../../backend/marketing/ports/hermes';
import { DEFAULT_GROWTH_PRIMARY_GOAL } from '../../backend/social-content/brand-kit-payload';
import { normalizeGoal } from '../../backend/insights/goal/goal-snapshot-builder';
import { formatPerformanceContext } from '../../backend/marketing/performance-context';

const WEEKLY = 'social_content_weekly';

// ── 1. default goal ↔ canonical GoalType ────────────────────────────────────

test('DEFAULT_GROWTH_PRIMARY_GOAL maps to the canonical content_growth goal, confidently', () => {
  const { goal, inferred } = normalizeGoal(DEFAULT_GROWTH_PRIMARY_GOAL);
  assert.equal(
    goal,
    'content_growth',
    'the defaulted goal must land on content_growth — whose Insights metric is SUM(followers_delta),'
    + ' the exact KPI the stage instructions name. Any other bucket splits Insights from the content pipeline.',
  );
  assert.equal(
    inferred,
    false,
    'a keyword match must be confident: inferred:true means normalizeGoal GUESSED, which would surface'
    + ' the "Goal inferred — confirm in Settings" chip for the wrong reason.',
  );
});

test('DEFAULT_GROWTH_PRIMARY_GOAL avoids the keyword buckets that are tested before content_growth', () => {
  // normalizeGoalValue tests lead_generation, then product_sales, then
  // content_growth. A stray "booking"/"order"/"product" in the default string
  // silently wins over the growth keywords.
  const lower = DEFAULT_GROWTH_PRIMARY_GOAL.toLowerCase();
  const earlierBuckets = [
    /\blead|inquir|enquir|contact|sign[- ]?up|booking|appointment\b/,
    /\bsale|sell|revenue|purchase|buy|checkout|conversion|order|product|shop|ecommerce\b/,
  ];
  for (const pattern of earlierBuckets) {
    assert.ok(
      !pattern.test(lower),
      `default goal must not match ${pattern} — that bucket is evaluated before content_growth`,
    );
  }
  assert.match(lower, /\bfollow|grow|audience\b/, 'default goal must carry a content_growth keyword');
});

// ── 2. KPI scope: strategy + publish only ───────────────────────────────────

test('the STRATEGY stage instructions carry the growth KPI contract', () => {
  const instructions = buildHermesStageInstructions(WEEKLY, 'strategy');
  assert.ok(instructions.includes('followers_delta'), 'strategy must name followers_delta as a success metric');
  assert.ok(instructions.includes('FOLLOWER GROWTH'), 'strategy must state the growth objective');
  assert.ok(
    instructions.includes('follow, save, or comment'),
    'strategy must require an explicit growth mechanism per post',
  );
  assert.ok(
    instructions.includes('strategist'),
    'the KPI must be additive — the strategist contract itself must survive',
  );
});

test('the PUBLISH stage instructions carry the growth KPI contract', () => {
  const instructions = buildHermesStageInstructions(WEEKLY, 'publish');
  assert.ok(instructions.includes('followers_delta'), 'publish must name followers_delta as a success metric');
  assert.ok(
    instructions.includes('pure broadcast'),
    'publish pre-flight must call out posts with no growth mechanism',
  );
  assert.ok(
    instructions.includes('approve_stage_4_publish'),
    'the KPI must be additive — the publish checkpoint contract must survive',
  );
});

test('research and production stage instructions stay free of the KPI block', () => {
  for (const stage of ['research', 'production'] as const) {
    const instructions = buildHermesStageInstructions(WEEKLY, stage);
    assert.ok(
      !instructions.includes('followers_delta'),
      `${stage} must not carry the KPI block — it is tool-budget/asset-contract scoped`,
    );
  }
  // Scope guard on the fragments that DO belong to those stages.
  assert.ok(buildHermesStageInstructions(WEEKLY, 'research').includes('web_search'));
  assert.ok(buildHermesStageInstructions(WEEKLY, 'production').includes('image_generate'));
});

test('the terminal publish-finalize run stays a bare completed echo', () => {
  const instructions = buildHermesStageInstructions(WEEKLY, 'publish', 'approve_stage_4_publish');
  assert.ok(
    !instructions.includes('followers_delta'),
    'publish-finalize does no planning — a KPI paragraph there is pure prompt tax',
  );
  assert.ok(instructions.includes('"status":"completed"'), 'finalize must still demand a terminal envelope');
  assert.ok(!instructions.includes('requires_approval'), 'finalize must not re-emit an approval checkpoint');
});

test('the brand-campaign workflow is untouched by the weekly KPI contract', () => {
  const instructions = buildHermesStageInstructions('marketing_pipeline', 'strategy');
  assert.ok(
    !instructions.includes('followers_delta'),
    'marketing_pipeline keeps its combined instruction set — this item does not own it',
  );
});

// ── 3. the KPI's promises must match reality ────────────────────────────────

test('the KPI subordinates itself to an explicitly stated non-growth goal', () => {
  // One-off campaigns share SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY and therefore
  // these stage builders, and the Objective (JSON) echoed into the run input
  // can carry an operator-stated goal like "Book more consulting calls".
  // Unconditional "optimize for followers" would override a paying tenant.
  assert.ok(
    GROWTH_OBJECTIVE_KPI.includes('unless the Objective (JSON) in the input states a different primary_goal'),
    'the KPI must open with the subordination condition',
  );
  assert.ok(
    GROWTH_OBJECTIVE_KPI.includes('THAT goal stays primary')
    && GROWTH_OBJECTIVE_KPI.includes('secondary scoreboard'),
    'the KPI must explicitly demote growth to secondary when another goal is stated',
  );
  for (const stage of ['strategy', 'publish'] as const) {
    assert.ok(
      buildHermesStageInstructions(WEEKLY, stage).includes('secondary scoreboard'),
      `${stage} must ship the subordination clause, not just the objective`,
    );
  }
});

test('the KPI describes the engagement metric the performance block actually reports', () => {
  // backend/marketing/performance-context.ts emits an ABSOLUTE per-post count
  // of likes + comments_count + shares (saves is NULL on every row the Meta
  // sync writes today) and renders reach only when it is present and > 0.
  // Promising "engagement rate against reach" would score the model on a
  // number the block does not contain.
  assert.ok(
    GROWTH_OBJECTIVE_KPI.includes('likes + comments + shares'),
    'the KPI must state the same three terms the block sums',
  );
  assert.ok(
    GROWTH_OBJECTIVE_KPI.includes('saves are not collected today'),
    'the KPI must not imply saves are part of the reported score',
  );
  assert.ok(
    GROWTH_OBJECTIVE_KPI.includes('where the performance block reports a reach figure'),
    'reach is conditional in the block, so the KPI must state it conditionally — not as a denominator',
  );
  assert.ok(
    !/engagement rate/i.test(GROWTH_OBJECTIVE_KPI),
    'no "engagement rate": the block reports counts, not a rate',
  );
});

test('the KPI names the performance block by the heading it actually emits', () => {
  // Cross-checked against the real formatter rather than a copied literal: the
  // KPI tells the model to look for a named block, and if the formatter's
  // header is reworded the model is hunting for a block it will never
  // recognise — with no error anywhere.
  const block = formatPerformanceContext(
    [{
      platform: 'instagram',
      media_type: 'reel',
      content_type: null,
      caption: 'A hook that worked',
      permalink: null,
      published_at: '2026-08-01',
      engagement: 120,
      likes: 100,
      comments: 15,
      shares: 5,
      reach: 4000,
      rn_top: 1,
      rn_bottom: 1,
      total_posts: 1,
    }],
    [],
  );
  assert.ok(block, 'fixture must produce a block');
  const quoted = GROWTH_OBJECTIVE_KPI.match(/"([^"]+)" block for this account/);
  assert.ok(quoted, 'the KPI must reference the performance block by a quoted name');
  assert.ok(
    block.full.startsWith(quoted[1]),
    `the KPI names "${quoted[1]}" but the formatter emits "${block.full.slice(0, 60)}…"`,
  );
});
