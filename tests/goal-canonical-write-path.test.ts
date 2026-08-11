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
  resolveGoalTypeForWrite,
} from '../backend/insights/goal/goal-options';
import { GOAL_TYPES, deriveStoredGoalType } from '../backend/insights/goal/goal-type-classification';

/**
 * AA-114 (S6-1, gaps A6a/F3) — the canonical goal WRITE path.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/goal-canonical-write-path.test.ts
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const read = (...p: string[]) => readFileSync(path.join(PROJECT_ROOT, ...p), 'utf8');

// ── Vocabulary ───────────────────────────────────────────────────────────────

test('the select offers exactly the four goals the column allows', () => {
  assert.deepEqual(
    CANONICAL_GOAL_OPTIONS.map((o) => o.value).sort(),
    [...GOAL_TYPES].sort(),
    'an option outside the CHECK constraint would fail every save',
  );
  for (const option of CANONICAL_GOAL_OPTIONS) {
    assert.ok(option.label.trim() && option.description.trim(), `${option.value} needs copy`);
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

test('A6a: "Increase social media presence" means audience growth, not brand awareness', () => {
  // The gap this card exists for. Read as free text the label matches no keyword
  // family and lands on the brand_awareness fallback, while the option itself is
  // explicitly about followers and engagement.
  assert.equal(deriveStoredGoalType('Increase social media presence'), null, 'keyword derivation cannot place it');
  assert.equal(goalTypeForPresetLabel('Increase social media presence'), 'content_growth');
  assert.equal(goalTypeForWrittenText('Increase social media presence'), 'content_growth');
});

test('the goal a user picks matches the KPI the prompts optimise for (#964)', () => {
  // #964 put explicit follower-growth KPIs into the strategy/publish
  // instructions. content_growth is the goal whose metric is SUM(followers_delta).
  // If that pairing ever drifts, the prompts and the dashboard would optimise
  // for and report on different numbers — the failure this pins.
  const builder = read('backend', 'insights', 'goal', 'goal-snapshot-builder.ts');
  assert.match(
    builder,
    /content_growth\s*→\s*net new followers \(SUM of followers_delta\)/,
    'content_growth must remain the followers metric',
  );
  const growth = CANONICAL_GOAL_OPTIONS.find((o) => o.value === 'content_growth');
  assert.ok(growth, 'the select must offer content_growth');
  assert.match(growth.description, /[Ff]ollower/, 'its description must say what it measures');
  assert.equal(
    goalTypeForPresetLabel('Increase social media presence'),
    'content_growth',
    'the growth-shaped onboarding preset must reach the growth goal',
  );
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
    assert.equal(presetLabelForGoalType(preset.goalType), preset.label);
  }
  assert.equal(presetLabelForGoalType(null), '');
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
  assert.equal(
    resolveGoalTypeForWrite({ ...BASE, storedGoalType: 'product_sales' }),
    'product_sales',
  );
});

test('editing an UNRELATED field never overwrites a chosen goal', () => {
  // The regression this resolver exists to prevent: the old write path
  // re-derived from the free text on every save, so saving a competitor URL
  // silently replaced an operator's chosen goal with a keyword guess.
  assert.equal(
    resolveGoalTypeForWrite({
      explicitGoalType: undefined,
      storedGoalType: 'brand_awareness',
      previousPrimaryGoal: 'Generate more leads',
      nextPrimaryGoal: 'Generate more leads',
    }),
    'brand_awareness',
  );
});

test('changing the goal TEXT re-resolves, so a stale key never outlives it', () => {
  assert.equal(
    resolveGoalTypeForWrite({
      explicitGoalType: undefined,
      storedGoalType: 'lead_generation',
      previousPrimaryGoal: 'Generate more leads',
      nextPrimaryGoal: 'sell more product',
    }),
    'product_sales',
  );
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
  const source = read('frontend', 'aries-v1', 'onboarding-flow.tsx');
  const fnStart = source.indexOf('function goalFromBusinessProfile(');
  assert.ok(fnStart > 0, 'goalFromBusinessProfile should still exist');
  const fnBody = source.slice(fnStart, source.indexOf('\n}\n', fnStart));

  for (const smell of ["includes('lead')", "includes('sell')", "includes('quiz')", "includes('social')"]) {
    assert.ok(!fnBody.includes(smell), `keyword guess ${smell} must be gone`);
  }
  assert.match(fnBody, /presetLabelForGoalType/, 'it must read the canonical key instead');
  assert.match(source, /ONBOARDING_GOAL_PRESETS/, 'presets must come from the shared list');
});

test('the profile write path resolves the key instead of deriving it blind', () => {
  const source = read('backend', 'tenant', 'business-profile.ts');
  assert.match(source, /resolveGoalTypeForWrite\(/);
  // The record loader must HONOR a persisted key rather than recomputing it —
  // recomputing discarded an operator's choice on every read.
  assert.match(source, /isCanonicalGoalType\(value\.goal_type\)/);
  assert.match(source, /goalType: input\.record\?\.goal_type \?\? null/);
  // No site may go back to deriving blind on a write.
  assert.doesNotMatch(source, /goal_type:\s*deriveStoredGoalType\(/);
});

test('the Business Profile screen offers the select AND keeps the free text', () => {
  const screen = read('frontend', 'aries-v1', 'business-profile-screen.tsx');
  assert.match(screen, /CANONICAL_GOAL_OPTIONS\.map/, 'the select must render the canonical list');
  assert.match(screen, /goalType: goalType === '' \? null : goalType/, 'and save it');
  assert.match(screen, /value=\{primaryGoal\}/, 'the free text still feeds the Hermes prompts');
});

test('the API rejects a non-canonical goalType instead of persisting it', () => {
  const route = read('app', 'api', 'business', 'profile', 'route.ts');
  assert.match(route, /isCanonicalGoalType\(payload\.goalType\)/);
  assert.match(route, /payload\.goalType === undefined/, 'undefined must mean "unchanged"');
});

test('the column and its migration declare the same four values (two-place rule)', () => {
  // The reviewer believed the DDL did not create goal_type. It does — in both
  // places — which is why #964's information_schema-guarded backfill will not
  // no-op on a container that has run init-db.
  const ddl = read('scripts', 'init-db.js');
  assert.match(ddl, /goal_type TEXT CHECK \(goal_type IS NULL OR goal_type IN \(/);
  assert.match(ddl, /ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS goal_type TEXT/);
  const migration = read('migrations', '20260801000000_business_profiles_goal_type.sql');
  for (const goal of GOAL_TYPES) {
    assert.ok(ddl.includes(`'${goal}'`), `init-db missing ${goal}`);
    assert.ok(migration.includes(`'${goal}'`), `migration missing ${goal}`);
  }
});
