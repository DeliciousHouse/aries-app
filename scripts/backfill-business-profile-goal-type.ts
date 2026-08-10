/**
 * AA-115 / S6-2 (gap F3b) — backfill `business_profiles.goal_type` from the
 * existing free-text `primary_goal`, with low-confidence flagging.
 *
 * `primary_goal` is free-form and has four free-form writers. The insights read
 * path re-derives a canonical goal from it by regex on every request,
 * first-match-wins, and defaults every miss to brand_awareness so the label and
 * narrative are never blank. That default is a GUESS — and two shipped
 * onboarding presets land on it ("Increase social media presence", "Book more
 * qualified calls"), which is the misclassification S1-5's confirm chip exists
 * to surface.
 *
 * This pass freezes the mappings that are NOT guesses and refuses to touch the
 * ones that are:
 *
 *   confident  → exact canonical key, or exactly ONE keyword family matched.
 *                Writes goal_type. The chip stops asking, because there is
 *                nothing left to decide.
 *   ambiguous  → 2+ keyword families matched. The read path silently takes the
 *                first by family order; persisting that would dress a regex
 *                tie-break up as a settled decision. Left NULL → chip stays.
 *   unmatched  → nothing matched. Left NULL → chip stays. This is the "no
 *                silent baking-in of today's brand_awareness misclassifications"
 *                requirement, and it is why this is a script and not a SQL
 *                UPDATE in the migration.
 *
 * SAFETY INVARIANT: the classifier shares its keyword families with the read
 * path (backend/insights/goal/goal-type-classification.ts), and a confident
 * classification is by construction the same goal the read path already
 * resolves. So this backfill NEVER changes which metric a tenant sees — only
 * whether Aries is still asking them to confirm it. Pinned in
 * tests/insights-goal-type-backfill.test.ts.
 *
 * Idempotent: only ever updates rows where goal_type IS NULL, and the UPDATE
 * re-asserts that predicate, so a row written concurrently by a profile save is
 * skipped rather than clobbered. Running it twice is a no-op the second time.
 *
 * Sequential batched loop by tenant_id cursor (guardrail #1 — no Promise.all
 * around PostgreSQL).
 *
 * Usage:
 *   tsx scripts/backfill-business-profile-goal-type.ts --all --dry-run
 *   tsx scripts/backfill-business-profile-goal-type.ts --all
 *   tsx scripts/backfill-business-profile-goal-type.ts --tenant 15 --dry-run
 *   tsx scripts/backfill-business-profile-goal-type.ts --tenant 15
 *
 * Run --dry-run FIRST: it prints the confident/ambiguous/unmatched split and a
 * sample of the free text in each low-confidence bucket, which is the signal for
 * whether the keyword vocabulary needs widening before the real pass.
 */

import path from 'node:path';

import {
  classifyGoalText,
  GOAL_TYPES,
  type GoalClassificationReason,
  type GoalType,
} from '@/backend/insights/goal/goal-type-classification';

const BATCH_SIZE = 500;
/** How many distinct free-text values to show per low-confidence bucket. */
const SAMPLE_LIMIT = 12;

type Row = {
  tenant_id: number;
  primary_goal: string | null;
};

type Db = {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

function parseArgs(argv: string[]): { tenant: number | null; all: boolean; dryRun: boolean } {
  let tenant: number | null = null;
  let all = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant') {
      const next = argv[i + 1];
      const parsed = next ? Number(next) : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--tenant requires a positive integer id, got: ${next ?? '(missing)'}`);
      }
      tenant = parsed;
      i += 1;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }
  return { tenant, all, dryRun };
}

function logInfo(message: string, fields?: Record<string, unknown>): void {
  process.stdout.write(
    fields
      ? `[backfill-goal-type] ${message} ${JSON.stringify(fields)}\n`
      : `[backfill-goal-type] ${message}\n`,
  );
}

function logWarn(message: string, fields?: Record<string, unknown>): void {
  process.stderr.write(
    fields
      ? `[backfill-goal-type] WARN ${message} ${JSON.stringify(fields)}\n`
      : `[backfill-goal-type] WARN ${message}\n`,
  );
}

export type GoalTypeBackfillStats = {
  scanned: number;
  confident: number;
  ambiguous: number;
  unmatched: number;
  rowsUpdated: number;
  errors: number;
  /** Confident rows per canonical key — what the backfill actually wrote. */
  buckets: Record<GoalType, number>;
  /**
   * Distinct free-text values that did NOT map confidently, capped at
   * SAMPLE_LIMIT each. This is the operator-facing output of a dry run: it says
   * exactly which goal copy the vocabulary fails to understand.
   */
  ambiguousSamples: string[];
  unmatchedSamples: string[];
  /** Rows that already carried a goal_type when the run started. */
  preClassified: number;
};

function emptyBuckets(): Record<GoalType, number> {
  const buckets = {} as Record<GoalType, number>;
  for (const goal of GOAL_TYPES) buckets[goal] = 0;
  return buckets;
}

function collectSample(samples: string[], seen: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (!trimmed || seen.has(trimmed.toLowerCase()) || samples.length >= SAMPLE_LIMIT) return;
  seen.add(trimmed.toLowerCase());
  samples.push(trimmed);
}

export async function runBackfillBusinessProfileGoalType(options: {
  db: Db;
  tenantId?: number | null;
  dryRun: boolean;
  batchSize?: number;
}): Promise<GoalTypeBackfillStats> {
  const { db, tenantId, dryRun } = options;
  const batchSize = options.batchSize ?? BATCH_SIZE;

  const stats: GoalTypeBackfillStats = {
    scanned: 0,
    confident: 0,
    ambiguous: 0,
    unmatched: 0,
    rowsUpdated: 0,
    errors: 0,
    buckets: emptyBuckets(),
    ambiguousSamples: [],
    unmatchedSamples: [],
    preClassified: 0,
  };

  const ambiguousSeen = new Set<string>();
  const unmatchedSeen = new Set<string>();

  // Rows already carrying a canonical key when this run started, so the report
  // can state coverage over the whole scope rather than only over the rows still
  // NULL at run time (a second run would otherwise report 0% and look broken).
  {
    const countParams: unknown[] = tenantId ? [tenantId] : [];
    const tenantFilter = tenantId ? 'AND tenant_id = $1' : '';
    const countResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM business_profiles
        WHERE goal_type IS NOT NULL
          AND primary_goal IS NOT NULL
          ${tenantFilter}`,
      countParams,
    );
    stats.preClassified = Number(countResult.rows[0]?.count ?? 0);
  }

  let cursor = 0;
  for (;;) {
    const params: unknown[] = tenantId ? [cursor, tenantId, batchSize] : [cursor, batchSize];
    const tenantFilter = tenantId ? 'AND tenant_id = $2' : '';
    const limitParam = tenantId ? '$3' : '$2';
    const result = await db.query<Row>(
      `SELECT tenant_id, primary_goal
         FROM business_profiles
        WHERE goal_type IS NULL
          AND primary_goal IS NOT NULL
          AND tenant_id > $1
          ${tenantFilter}
        ORDER BY tenant_id ASC
        LIMIT ${limitParam}`,
      params,
    );
    const rows = result.rows;
    if (rows.length === 0) break;

    // Sequential — no Promise.all around pg (guardrail #1).
    for (const row of rows) {
      stats.scanned += 1;
      cursor = row.tenant_id;

      const classification = classifyGoalText(row.primary_goal);
      const rawGoal = row.primary_goal ?? '';

      if (!classification.confident || !classification.goalType) {
        const reason: GoalClassificationReason = classification.reason;
        if (reason === 'ambiguous') {
          stats.ambiguous += 1;
          collectSample(stats.ambiguousSamples, ambiguousSeen, rawGoal);
        } else {
          stats.unmatched += 1;
          collectSample(stats.unmatchedSamples, unmatchedSeen, rawGoal);
        }
        // Left NULL on purpose: the S1-5 confirm chip keeps asking.
        continue;
      }

      stats.confident += 1;
      stats.buckets[classification.goalType] += 1;

      if (dryRun) continue;

      try {
        const update = await db.query(
          `UPDATE business_profiles
              SET goal_type = $2
            WHERE tenant_id = $1
              AND goal_type IS NULL`,
          [row.tenant_id, classification.goalType],
        );
        if ((update.rowCount ?? 0) > 0) stats.rowsUpdated += 1;
      } catch (err) {
        stats.errors += 1;
        logWarn('update failed', { tenantId: row.tenant_id, error: (err as Error)?.message });
      }
    }

    if (rows.length < batchSize) break;
  }

  return stats;
}

function printReport(stats: GoalTypeBackfillStats, dryRun: boolean): void {
  const totalScope = stats.preClassified + stats.scanned;
  const combinedConfident = stats.preClassified + stats.confident;
  const pct = totalScope > 0 ? ((combinedConfident / totalScope) * 100).toFixed(1) : '0.0';

  logInfo('confident goal_type distribution', { ...stats.buckets });
  if (stats.ambiguousSamples.length > 0) {
    logInfo('left NULL — ambiguous (2+ keyword families matched)', { samples: stats.ambiguousSamples });
  }
  if (stats.unmatchedSamples.length > 0) {
    logInfo('left NULL — unmatched (no keyword family matched)', { samples: stats.unmatchedSamples });
  }
  logInfo('summary', {
    dryRun,
    scanned: stats.scanned,
    preClassified: stats.preClassified,
    newlyConfident: stats.confident,
    ambiguous: stats.ambiguous,
    unmatched: stats.unmatched,
    totalScope,
    combinedPctConfident: `${pct}%`,
    rowsUpdated: stats.rowsUpdated,
    errors: stats.errors,
  });
  if (stats.ambiguous + stats.unmatched > 0) {
    logInfo(
      `${stats.ambiguous + stats.unmatched} profile(s) left unclassified on purpose — they keep the "Goal inferred — confirm" chip.`,
    );
  }
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return (
      entry.endsWith('backfill-business-profile-goal-type.ts') ||
      entry.endsWith('backfill-business-profile-goal-type.js')
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void (async () => {
    let tenant: number | null;
    let all: boolean;
    let dryRun: boolean;
    try {
      ({ tenant, all, dryRun } = parseArgs(process.argv.slice(2)));
    } catch (err) {
      logWarn('FATAL', { error: (err as Error)?.message });
      process.exit(1);
      return;
    }
    if (!tenant && !all) {
      logWarn('FATAL', { error: 'pass either --tenant <id> or --all' });
      process.exit(1);
      return;
    }
    if (tenant && all) {
      logWarn('FATAL', { error: 'pass either --tenant <id> or --all, not both' });
      process.exit(1);
      return;
    }

    const { pool } = await import('@/lib/db');
    try {
      const stats = await runBackfillBusinessProfileGoalType({ db: pool, tenantId: tenant, dryRun });
      printReport(stats, dryRun);
    } catch (err) {
      logWarn('FATAL', { error: (err as Error)?.message });
      process.exit(1);
    } finally {
      try {
        await pool.end();
      } catch {
        // ignore pool shutdown errors
      }
    }
  })();
}
