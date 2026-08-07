/**
 * tests/insights-goal-type-backfill.test.ts
 *
 * AA-115 / S6-2 (gap F3b) — goal backfill with low-confidence flagging.
 *
 * The card's two halves:
 *   (a) auto-migrate CLEAR keyword matches to business_profiles.goal_type;
 *   (b) leave ambiguous rows flagged for the S1-5 confirm chip, with
 *       "no silent baking-in of today's brand_awareness misclassifications".
 *
 * The load-bearing assertions here are the ones that stop this from being able
 * to move a live tenant's numbers:
 *   - a CONFIDENT classification always equals what the read path already
 *     resolves, so backfilling never changes which metric is rendered;
 *   - the fallthrough default (brand_awareness) is NEVER persisted;
 *   - a NULL goal_type resolves byte-identically to the pre-AA-115 behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  classifyGoalText,
  deriveStoredGoalType,
  GOAL_FALLBACK,
  GOAL_TYPES,
  isGoalType,
} from '../backend/insights/goal/goal-type-classification';
import {
  normalizeGoal,
  resolveGoalWithProvenance,
} from '../backend/insights/goal/goal-snapshot-builder';
import { runBackfillBusinessProfileGoalType } from '../scripts/backfill-business-profile-goal-type';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

/** Run fn with console.warn silenced (the read path logs every fallthrough). */
function quiet<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

// A spread of real onboarding/enrichment goal copy. The presets come from
// backend/tenant/business-profile.ts::inferPrimaryGoalFromSignals and the
// shipped onboarding options.
const CORPUS = [
  'lead_generation',
  'content_growth',
  'product_sales',
  'brand_awareness',
  'Generate more qualified leads',
  'Generate more leads and inquiries',
  'Increase offer sales',
  'Drive product sales',
  'Book more qualified calls',
  'Stay visible every week',
  'Increase social media presence',
  'Grow my following',
  'Build brand awareness',
  'reach more customers',
  'sell more product to a bigger audience',
  'Get more bookings',
  '',
  '   ',
];

// ── The classifier ─────────────────────────────────────────────────────────────

test('an exact canonical key classifies confidently as itself', () => {
  for (const goal of GOAL_TYPES) {
    const result = classifyGoalText(goal);
    assert.equal(result.confident, true, `${goal} must be confident`);
    assert.equal(result.goalType, goal);
    assert.equal(result.reason, 'exact_key');
  }
});

test('a single matching keyword family classifies confidently', () => {
  const leads = classifyGoalText('Generate more qualified leads');
  assert.equal(leads.confident, true);
  assert.equal(leads.goalType, 'lead_generation');
  assert.equal(leads.reason, 'single_keyword_family');

  const sales = classifyGoalText('Increase offer sales');
  assert.equal(sales.confident, true);
  assert.equal(sales.goalType, 'product_sales');

  const visible = classifyGoalText('Stay visible every week');
  assert.equal(visible.confident, true);
  assert.equal(visible.goalType, 'brand_awareness');
});

test('two or more matching families are ambiguous and persist nothing', () => {
  // "reach more" is a content_growth keyword and "reach" is a brand_awareness
  // keyword. The read path silently takes content_growth by family order; a
  // stored key would dress that regex tie-break up as a settled decision.
  const result = classifyGoalText('reach more customers');
  assert.equal(result.confident, false);
  assert.equal(result.goalType, null, 'an ambiguous row must not be given a canonical key');
  assert.equal(result.reason, 'ambiguous');
  assert.ok(result.matchedGoals.length >= 2, 'ambiguity means more than one family matched');
});

test('the unmatched onboarding presets stay unclassified, NOT baked in as brand_awareness', () => {
  // These are the exact strings named by A6/S1-5. The read path renders
  // brand_awareness for both; persisting that would permanently silence the
  // confirm chip for the tenants who most need it.
  for (const preset of ['Increase social media presence', 'Book more qualified calls']) {
    const result = classifyGoalText(preset);
    assert.equal(result.confident, false, `${preset} must not be confident`);
    assert.equal(result.goalType, null, `${preset} must not persist a goal_type`);
    assert.equal(result.reason, 'unmatched');

    // ...and the read path still renders the fallback, unchanged.
    assert.equal(quiet(() => normalizeGoal(preset)).goal, GOAL_FALLBACK);
  }
});

test('blank goal text is unmatched, never a persisted key', () => {
  for (const blank of ['', '   ', null, undefined]) {
    const result = classifyGoalText(blank);
    assert.equal(result.goalType, null);
    assert.equal(result.confident, false);
  }
});

test('the fallthrough default is never persisted for text that did not match it', () => {
  for (const raw of CORPUS) {
    const stored = deriveStoredGoalType(raw);
    if (stored !== GOAL_FALLBACK) continue;
    // If we persisted brand_awareness, it must be because the text genuinely
    // matched the awareness family (or IS the key) — never because we fell through.
    const classification = classifyGoalText(raw);
    assert.notEqual(
      classification.reason,
      'unmatched',
      `"${raw}" must not persist the fallthrough default`,
    );
    assert.deepEqual(classification.matchedGoals, [GOAL_FALLBACK]);
  }
});

// ── The safety invariant ───────────────────────────────────────────────────────

test('a confident classification always equals the goal the read path already resolves', () => {
  // This is what makes the backfill safe to run on production: it can change
  // whether a tenant is ASKED to confirm their goal, never which metric they see.
  for (const raw of CORPUS) {
    const classification = classifyGoalText(raw);
    if (!classification.confident || !classification.goalType) continue;
    const resolved = quiet(() => normalizeGoal(raw));
    assert.equal(
      classification.goalType,
      resolved.goal,
      `"${raw}": backfilled key must match the rendered goal`,
    );
    assert.equal(resolved.inferred, false, `"${raw}": a confident match is never inferred`);
  }
});

test('a stored goal_type settles the goal; a NULL one falls back to today behavior exactly', () => {
  const preset = 'Increase social media presence';

  // Stored key present → authoritative, and the confirm chip has nothing to ask.
  assert.deepEqual(
    quiet(() => resolveGoalWithProvenance(preset, 'inferred', 'lead_generation')),
    { goal: 'lead_generation', inferred: false },
  );

  // NULL / absent / junk → byte-identical to the pre-AA-115 resolution.
  for (const stored of [null, undefined, '', 'not_a_goal']) {
    assert.deepEqual(
      quiet(() => resolveGoalWithProvenance(preset, 'inferred', stored)),
      quiet(() => resolveGoalWithProvenance(preset, 'inferred')),
      `stored=${JSON.stringify(stored)} must not change resolution`,
    );
  }

  // The explicit-provenance suppression AA-151 shipped is untouched.
  assert.deepEqual(
    quiet(() => resolveGoalWithProvenance(preset, 'explicit')),
    { goal: GOAL_FALLBACK, inferred: false },
  );
  assert.deepEqual(
    quiet(() => resolveGoalWithProvenance(preset, 'inferred')),
    { goal: GOAL_FALLBACK, inferred: true },
  );
});

// ── The backfill pass ──────────────────────────────────────────────────────────

type FakeRow = { tenant_id: number; primary_goal: string | null; goal_type: string | null };

/** Minimal in-memory stand-in for the two statements the backfill issues. */
function fakeDb(rows: FakeRow[]) {
  const updates: Array<{ tenantId: number; goalType: string }> = [];
  return {
    rows,
    updates,
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      if (text.includes('COUNT(*)')) {
        const count = rows.filter((r) => r.goal_type !== null && r.primary_goal !== null).length;
        return { rows: [{ count: String(count) }] as unknown as T[], rowCount: 1 };
      }
      if (text.startsWith('SELECT tenant_id')) {
        const cursor = Number(params[0]);
        const limit = Number(params[params.length - 1]);
        const page = rows
          .filter((r) => r.goal_type === null && r.primary_goal !== null && r.tenant_id > cursor)
          .sort((a, b) => a.tenant_id - b.tenant_id)
          .slice(0, limit);
        return { rows: page as unknown as T[], rowCount: page.length };
      }
      if (text.includes('UPDATE business_profiles')) {
        const [tenantId, goalType] = params as [number, string];
        const row = rows.find((r) => r.tenant_id === tenantId);
        // Mirrors the SQL's `AND goal_type IS NULL` re-assertion.
        if (!row || row.goal_type !== null) return { rows: [] as T[], rowCount: 0 };
        row.goal_type = goalType;
        updates.push({ tenantId, goalType });
        return { rows: [] as T[], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

function seedRows(): FakeRow[] {
  return [
    { tenant_id: 1, primary_goal: 'Generate more qualified leads', goal_type: null },
    { tenant_id: 2, primary_goal: 'Increase social media presence', goal_type: null },
    { tenant_id: 3, primary_goal: 'reach more customers', goal_type: null },
    { tenant_id: 4, primary_goal: 'Increase offer sales', goal_type: null },
    { tenant_id: 5, primary_goal: 'Book more qualified calls', goal_type: null },
    { tenant_id: 6, primary_goal: 'brand_awareness', goal_type: null },
    { tenant_id: 7, primary_goal: null, goal_type: null },
    { tenant_id: 8, primary_goal: 'Stay visible every week', goal_type: 'lead_generation' },
  ];
}

test('the backfill writes only confident rows and leaves the rest flagged', async () => {
  const db = fakeDb(seedRows());
  const stats = await runBackfillBusinessProfileGoalType({ db, dryRun: false, batchSize: 3 });

  assert.equal(stats.confident, 3, 'leads, sales, exact key, and nothing else');
  assert.equal(stats.ambiguous, 1, '"reach more customers" matches two families');
  assert.equal(stats.unmatched, 2, 'both unmatched onboarding presets');
  assert.equal(stats.rowsUpdated, 3);
  assert.equal(stats.errors, 0);

  const byTenant = new Map(db.rows.map((r) => [r.tenant_id, r.goal_type]));
  assert.equal(byTenant.get(1), 'lead_generation');
  assert.equal(byTenant.get(4), 'product_sales');
  assert.equal(byTenant.get(6), 'brand_awareness', 'an exact canonical key is confident');

  // The rows that keep the S1-5 confirm chip.
  assert.equal(byTenant.get(2), null, 'unmatched preset must stay NULL');
  assert.equal(byTenant.get(3), null, 'ambiguous text must stay NULL');
  assert.equal(byTenant.get(5), null, 'unmatched preset must stay NULL');

  // A row with no goal text is not in scope at all.
  assert.equal(byTenant.get(7), null);
  // A row already classified is never rewritten.
  assert.equal(byTenant.get(8), 'lead_generation');
  assert.equal(stats.preClassified, 1);
});

test('every value the backfill writes is a valid canonical key', async () => {
  const db = fakeDb(seedRows());
  await runBackfillBusinessProfileGoalType({ db, dryRun: false, batchSize: 500 });
  for (const update of db.updates) {
    assert.ok(isGoalType(update.goalType), `wrote a non-canonical key: ${update.goalType}`);
  }
});

test('the backfill is idempotent — a second pass is a no-op', async () => {
  const db = fakeDb(seedRows());
  await runBackfillBusinessProfileGoalType({ db, dryRun: false, batchSize: 500 });
  const snapshot = db.rows.map((r) => `${r.tenant_id}:${r.goal_type}`).join('|');

  const second = await runBackfillBusinessProfileGoalType({ db, dryRun: false, batchSize: 500 });
  assert.equal(second.rowsUpdated, 0, 'a classified row leaves the predicate');
  assert.equal(second.confident, 0);
  assert.equal(db.rows.map((r) => `${r.tenant_id}:${r.goal_type}`).join('|'), snapshot);
});

test('--dry-run classifies but mutates nothing', async () => {
  const db = fakeDb(seedRows());
  const stats = await runBackfillBusinessProfileGoalType({ db, dryRun: true, batchSize: 500 });

  assert.equal(stats.confident, 3, 'a dry run still reports what it would write');
  assert.equal(stats.rowsUpdated, 0);
  assert.equal(db.updates.length, 0, 'dry run must issue no UPDATE');
  assert.equal(db.rows.filter((r) => r.tenant_id !== 8).every((r) => r.goal_type === null), true);

  // The operator-facing signal: which copy the vocabulary failed to understand.
  assert.ok(stats.unmatchedSamples.includes('Increase social media presence'));
  assert.ok(stats.ambiguousSamples.includes('reach more customers'));
});

test('a per-row update failure is isolated and counted, not fatal', async () => {
  const db = fakeDb(seedRows());
  const realQuery = db.query.bind(db);
  let failed = false;
  db.query = (async (text: string, params: unknown[] = []) => {
    if (!failed && text.includes('UPDATE business_profiles')) {
      failed = true;
      throw new Error('simulated update failure');
    }
    return realQuery(text, params);
  }) as typeof db.query;

  const stats = await runBackfillBusinessProfileGoalType({ db, dryRun: false, batchSize: 500 });
  assert.equal(stats.errors, 1);
  assert.equal(stats.rowsUpdated, 2, 'the remaining confident rows still land');
});

// ── Schema guards ──────────────────────────────────────────────────────────────

test('the goal_type migration and bootstrap add the column but write no data', () => {
  const migration = fs.readFileSync(
    path.join(PROJECT_ROOT, 'migrations', '20260801000000_business_profiles_goal_type.sql'),
    'utf8',
  );
  const initDb = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'init-db.js'), 'utf8');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS goal_type TEXT/);
  assert.match(initDb, /ADD COLUMN IF NOT EXISTS goal_type TEXT/);

  // No silent baking-in: neither file may populate goal_type. A SQL backfill
  // here would write the brand_awareness fallthrough for unmatched presets.
  assert.doesNotMatch(migration, /SET goal_type/i, 'the migration must not write goal_type');
  assert.doesNotMatch(migration, /UPDATE business_profiles/i);
  assert.doesNotMatch(initDb, /SET goal_type/i, 'bootstrap must not write goal_type');

  // The column is constrained to the canonical vocabulary.
  for (const goal of GOAL_TYPES) {
    assert.ok(migration.includes(`'${goal}'`), `migration CHECK must list ${goal}`);
    assert.ok(initDb.includes(`'${goal}'`), `init-db CHECK must list ${goal}`);
  }
});

test('the goal read path selects goal_type and the cache version was bumped', () => {
  const builder = fs.readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'insights', 'goal', 'goal-snapshot-builder.ts'),
    'utf8',
  );
  assert.match(
    builder,
    /SELECT primary_goal, primary_goal_source, goal_type FROM business_profiles/,
    'the snapshot builder must read the canonical key',
  );

  // goalInferred flips for confidently backfilled tenants, and the goal section
  // is 1h-cached — a stale body would keep showing the chip after the backfill.
  const handler = fs.readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'insights', 'goal', 'handler.ts'),
    'utf8',
  );
  // The guarantee is "the goal template was bumped at or after the backfill",
  // not "it is pinned at v9" — the section legitimately keeps versioning as
  // later tickets change its output (S4-2 took it to v10). Assert the floor so
  // this stays a real guard instead of a tripwire on every future bump.
  const version = handler.match(/TEMPLATE_VERSION = 'goal-template-v(\d+)'/);
  assert.ok(version, 'goal handler declares a goal-template-vN TEMPLATE_VERSION');
  assert.ok(
    Number(version![1]) >= 9,
    `goal TEMPLATE_VERSION must be >= v9 (the backfill bump); found v${version![1]}`,
  );
});

test('every primary_goal write path resolves goal_type alongside the text', () => {
  // SUPERSEDED BY S6-1/AA-114. This test used to require that every
  // record-building site call `deriveStoredGoalType` directly, because at the
  // time derivation was the only way a key could exist. Now an operator can
  // CHOOSE the key in the canonical select, and blind re-derivation on every
  // write is the bug rather than the guarantee — it silently replaced a human's
  // pick with a keyword guess whenever any unrelated field was saved.
  //
  // The invariant that actually mattered survives intact and is asserted here:
  // a stored key must never outlive the text it came from WITHOUT a human
  // having chosen it. `resolveGoalTypeForWrite` owns that rule (explicit pick >
  // re-resolve on changed text > keep stored > derive), and
  // tests/goal-canonical-write-path.test.ts pins each branch.
  const source = fs.readFileSync(
    path.join(PROJECT_ROOT, 'backend', 'tenant', 'business-profile.ts'),
    'utf8',
  );

  const resolutions = (source.match(/goal_type:\s*(resolveGoalTypeForWrite|goalTypeForWrittenText|current\?\.goal_type|isCanonicalGoalType)/g) ?? []).length
    + (source.match(/goal_type = goalTypeForWrittenText\(/g) ?? []).length;
  assert.ok(
    resolutions >= 4,
    `expected every record-building site to resolve goal_type, saw ${resolutions}`,
  );

  // No site may go back to deriving blind on a write.
  assert.doesNotMatch(
    source,
    /goal_type:\s*deriveStoredGoalType\(/,
    'a write path must resolve (honoring an explicit pick), not derive unconditionally',
  );
  assert.match(source, /goal_type = EXCLUDED\.goal_type/, 'the upsert must persist the resolved key');
});
