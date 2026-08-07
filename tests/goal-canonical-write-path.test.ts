import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import {
  CANONICAL_GOAL_OPTIONS,
  ONBOARDING_GOAL_PRESETS,
  goalTypeForPresetLabel,
  goalTypeForWrittenText,
  goalTypeLabel,
  isCanonicalGoalType,
  presetLabelForGoalType,
  resolveOnboardingGoalState,
  resolveGoalTypeForWrite,
} from '../backend/insights/goal/goal-options';
import { GOAL_TYPES, deriveStoredGoalType } from '../backend/insights/goal/goal-type-classification';

/**
 * S6-1 / AA-114 (gaps A6a/F3) — the canonical goal WRITE path.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/goal-canonical-write-path.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

// ── Vocabulary ───────────────────────────────────────────────────────────────

test('the select offers exactly the four canonical goals the column allows', () => {
  assert.deepEqual(
    CANONICAL_GOAL_OPTIONS.map((o) => o.value).sort(),
    [...GOAL_TYPES].sort(),
    'a select option outside the CHECK constraint would fail every save',
  );
  for (const option of CANONICAL_GOAL_OPTIONS) {
    assert.ok(option.label.trim(), `${option.value} needs a label`);
    assert.ok(option.description.trim(), `${option.value} needs a description`);
  }
});

test('an unset goal reads as "not set", never as a confident guess', () => {
  assert.equal(goalTypeLabel(null), 'Not set');
  assert.equal(goalTypeLabel(undefined), 'Not set');
  assert.equal(goalTypeLabel('lead_generation'), 'Generate leads');
});

test('isCanonicalGoalType rejects anything the column would refuse', () => {
  for (const good of GOAL_TYPES) assert.equal(isCanonicalGoalType(good), true, good);
  for (const bad of ['', 'LEAD_GENERATION', 'leads', 'other', null, undefined, 7, {}]) {
    assert.equal(isCanonicalGoalType(bad), false, String(bad));
  }
});

// ── The A6a fix ──────────────────────────────────────────────────────────────

test('A6a: "Increase social media presence" maps to audience growth, not brand awareness', () => {
  // The gap this card exists for. Read as free text the label matches no keyword
  // family and lands on the brand_awareness fallback, while the option itself is
  // explicitly about followers and engagement.
  assert.equal(deriveStoredGoalType('Increase social media presence'), null, 'keyword derivation cannot place it');
  assert.equal(goalTypeForPresetLabel('Increase social media presence'), 'content_growth');
  assert.equal(goalTypeForWrittenText('Increase social media presence'), 'content_growth');
});

test('every onboarding preset states its goal explicitly, including "none"', () => {
  const byLabel = new Map(ONBOARDING_GOAL_PRESETS.map((p) => [p.label, p.goalType]));
  assert.equal(byLabel.get('Get leads'), 'lead_generation');
  assert.equal(byLabel.get('Sell a product or service'), 'product_sales');
  assert.equal(byLabel.get('Increase social media presence'), 'content_growth');
  // These two correspond to no metric Aries reports. Null is the honest answer;
  // mapping them onto brand_awareness would turn an unknown into a fact.
  assert.equal(byLabel.get('Gather information'), null);
  assert.equal(byLabel.get('Other'), null);

  for (const preset of ONBOARDING_GOAL_PRESETS) {
    if (preset.goalType !== null) {
      assert.ok(isCanonicalGoalType(preset.goalType), `${preset.label} → invalid key`);
    }
  }
});

test('preset ↔ goal mapping round-trips for every mapped preset', () => {
  for (const preset of ONBOARDING_GOAL_PRESETS) {
    if (preset.goalType === null) continue;
    assert.equal(
      presetLabelForGoalType(preset.goalType),
      preset.label,
      `${preset.goalType} must re-select ${preset.label}`,
    );
  }
  assert.equal(presetLabelForGoalType(null), '');
});

test('onboarding hydration keeps mapped selection separate from custom prose', () => {
  assert.deepEqual(
    resolveOnboardingGoalState('Book high-ticket strategy calls', 'lead_generation'),
    {
      selection: 'Get leads',
      customGoal: '',
      primaryGoal: 'Book high-ticket strategy calls',
    },
  );
});

test('onboarding hydration gives unmapped canonical goals a valid custom state', () => {
  assert.deepEqual(
    resolveOnboardingGoalState('Become the category name', 'brand_awareness'),
    {
      selection: 'Other',
      customGoal: 'Become the category name',
      primaryGoal: 'Become the category name',
    },
  );
});

test('onboarding hydration round-trips custom prose with no canonical key', () => {
  assert.deepEqual(
    resolveOnboardingGoalState('Open a second studio', null),
    {
      selection: 'Other',
      customGoal: 'Open a second studio',
      primaryGoal: 'Open a second studio',
    },
  );
});

test('free-form text still falls through to the keyword derivation', () => {
  // Only shipped preset labels get the explicit treatment; genuine free text
  // keeps today's behavior so no live tenant moves buckets.
  assert.equal(goalTypeForWrittenText('Generate more leads'), 'lead_generation');
  assert.equal(goalTypeForWrittenText('sell more product'), 'product_sales');
  assert.equal(goalTypeForWrittenText('something unmappable'), null);
  assert.equal(goalTypeForWrittenText(''), null);
  assert.equal(goalTypeForWrittenText(null), null);
});

// ── The write resolver ───────────────────────────────────────────────────────

const BASE = {
  storedGoalType: null,
  previousPrimaryGoal: 'Generate more leads',
  nextPrimaryGoal: 'Generate more leads',
} as const;

test('an explicit choice wins over anything the text would imply', () => {
  assert.equal(
    resolveGoalTypeForWrite({ ...BASE, explicitGoalType: 'brand_awareness' }),
    'brand_awareness',
    'a human pick must not be overruled by prose',
  );
});

test('an explicit null clears the goal; undefined leaves it alone', () => {
  assert.equal(resolveGoalTypeForWrite({ ...BASE, explicitGoalType: null }), null);
  // Not supplied + unchanged text + a stored key ⇒ the stored key survives.
  assert.equal(
    resolveGoalTypeForWrite({ ...BASE, storedGoalType: 'product_sales' }),
    'product_sales',
  );
});

test('editing an UNRELATED field never overwrites a chosen goal', () => {
  // The regression this resolver exists to prevent: the old write path
  // re-derived from the free text on every save, so saving a competitor URL
  // silently replaced an operator's chosen goal with a keyword guess.
  const chosen = resolveGoalTypeForWrite({
    explicitGoalType: undefined,
    storedGoalType: 'brand_awareness',
    previousPrimaryGoal: 'Generate more leads',
    nextPrimaryGoal: 'Generate more leads',
  });
  assert.equal(chosen, 'brand_awareness', 'must not be re-derived to lead_generation');
});

test('changing the goal TEXT re-resolves, so a stale key never outlives it', () => {
  const rewritten = resolveGoalTypeForWrite({
    explicitGoalType: undefined,
    storedGoalType: 'lead_generation',
    previousPrimaryGoal: 'Generate more leads',
    nextPrimaryGoal: 'sell more product',
  });
  assert.equal(rewritten, 'product_sales');
});

test('a legacy row with no key derives one from its text', () => {
  assert.equal(
    resolveGoalTypeForWrite({
      explicitGoalType: undefined,
      storedGoalType: null,
      previousPrimaryGoal: 'Generate more leads',
      nextPrimaryGoal: 'Generate more leads',
    }),
    'lead_generation',
  );
});

// ── Source-level: the heuristics are actually retired ────────────────────────

test('onboarding no longer keyword-guesses the goal from free text', () => {
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'onboarding-flow.tsx'),
    'utf8',
  );
  const fnStart = source.indexOf('function goalFromBusinessProfile(');
  assert.ok(fnStart > 0, 'goalFromBusinessProfile should still exist');
  const fnBody = source.slice(fnStart, source.indexOf('\n}\n', fnStart));

  // The retired chain: substring tests over the stored prose.
  for (const smell of ["includes('lead')", "includes('sell')", "includes('quiz')", "includes('social')"]) {
    assert.ok(!fnBody.includes(smell), `keyword guess ${smell} must be gone`);
  }
  assert.match(fnBody, /resolveOnboardingGoalState/, 'it must read the canonical key instead');
});

test('onboarding presets come from the shared list, not a local copy', () => {
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'onboarding-flow.tsx'),
    'utf8',
  );
  assert.match(source, /ONBOARDING_GOAL_PRESETS/);
});

test('the profile write path resolves the key instead of deriving it blind', () => {
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'tenant', 'business-profile.ts'),
    'utf8',
  );
  assert.match(source, /resolveGoalTypeForWrite\(/, 'the update path must use the resolver');
  // The record loader must HONOR a persisted key rather than recomputing it —
  // recomputing discarded an operator's choice on every read.
  assert.match(source, /isCanonicalGoalType\(value\.goal_type\)/);
  assert.match(source, /goalType: input\.record\?\.goal_type \?\? null/);
});

test('the Business Profile screen offers the canonical select AND keeps the free text', () => {
  const screen = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'business-profile-screen.tsx'),
    'utf8',
  );
  assert.match(screen, /CANONICAL_GOAL_OPTIONS\.map/, 'the select must render the canonical list');
  assert.match(screen, /goalType: goalType === '' \? null : goalType/, 'and save it');
  // Both fields survive — the free text still feeds the Hermes brand prompts.
  assert.match(screen, /value=\{primaryGoal\}/);
});

test('the API rejects a non-canonical goalType instead of persisting it', async () => {
  const route = readFileSync(
    path.join(PROJECT_ROOT, 'app', 'api', 'business', 'profile', 'route.ts'),
    'utf8',
  );
  assert.match(route, /isCanonicalGoalType\(payload\.goalType\)/);
  assert.match(route, /payload\.goalType === undefined/, 'undefined must mean "unchanged"');

  const { PATCH } = await import('../app/api/business/profile/route');
  const response = await PATCH(new Request('https://aries.example.com/api/business/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goalType: 'not-a-canonical-goal' }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_goal_type' });
});
