/**
 * tests/insights-goal-inferred.test.ts
 *
 * S1-5 / AA-84 — stop the silent goal misclassification.
 *
 * `normalizeGoal` maps free-text business_profiles.primary_goal to a canonical
 * GoalType. When nothing matches it falls back to brand_awareness — but that is
 * a GUESS, and previously it happened silently. It must now:
 *   (a) return inferred:true ONLY on the terminal fallthrough, and
 *   (b) console.warn the original free text.
 * A confident match (exact key or keyword) must be inferred:false with no warn.
 *
 * Also asserts the goal section's no_goal empty state links to the real
 * business-profile Settings route (the dead "Go to Settings" text is fixed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeGoal,
  resolveGoalWithProvenance,
} from '../backend/insights/goal/goal-snapshot-builder';

/** Run fn with console.warn captured; returns the warn calls seen. */
function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test('unmatched onboarding preset "Increase social media presence" → inferred:true + logged', () => {
  const { result, warnings } = captureWarn(() => normalizeGoal('Increase social media presence'));
  // The intent-agnostic default is brand_awareness, but it must be MARKED as a guess.
  assert.equal(result.goal, 'brand_awareness');
  assert.equal(result.inferred, true, 'unmatched free text must be flagged inferred');
  assert.equal(warnings.length, 1, 'a guess must be logged for our visibility');
  assert.match(warnings[0], /Increase social media presence/, 'the log must include the original free text');
});

test('the same onboarding goal is confirmed only when its persisted provenance is explicit', () => {
  const explicit = captureWarn(() =>
    resolveGoalWithProvenance('Increase social media presence', 'explicit'),
  );
  const inferred = captureWarn(() =>
    resolveGoalWithProvenance('Increase social media presence', 'inferred'),
  );

  assert.deepEqual(explicit.result, { goal: 'brand_awareness', inferred: false });
  assert.deepEqual(inferred.result, { goal: 'brand_awareness', inferred: true });
});

test('empty goal string → inferred:true (still a guess)', () => {
  const { result } = captureWarn(() => normalizeGoal('   '));
  assert.equal(result.goal, 'brand_awareness');
  assert.equal(result.inferred, true);
});

test('keyword match "Generate more leads and inquiries" → lead_generation, inferred:false, no warn', () => {
  const { result, warnings } = captureWarn(() => normalizeGoal('Generate more leads and inquiries'));
  assert.equal(result.goal, 'lead_generation');
  assert.equal(result.inferred, false, 'a confident keyword match must NOT be inferred');
  assert.equal(warnings.length, 0, 'a confident match must not warn');
});

test('exact canonical "brand_awareness" → inferred:false, no warn', () => {
  const { result, warnings } = captureWarn(() => normalizeGoal('brand_awareness'));
  assert.equal(result.goal, 'brand_awareness');
  assert.equal(result.inferred, false);
  assert.equal(warnings.length, 0);
});

test('keyword match "Drive product sales" → product_sales, inferred:false', () => {
  const { result } = captureWarn(() => normalizeGoal('Drive product sales'));
  assert.equal(result.goal, 'product_sales');
  assert.equal(result.inferred, false);
});

test('goal section no_goal empty state links to the real business-profile Settings route', () => {
  // Guard against a regression to the dead "Go to Settings" text with no href.
  const src = fs.readFileSync(new URL('../frontend/insights/GoalSection.tsx', import.meta.url), 'utf8');
  assert.match(src, /\/dashboard\/settings\/business-profile/, 'empty state must link to a real Settings route');
  // The empty state must pass an action link, not bare "Go to Settings" prose.
  assert.doesNotMatch(src, /Go to Settings to configure/, 'the dead prose CTA must be gone');
});
