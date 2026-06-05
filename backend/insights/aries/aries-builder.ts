/**
 * backend/insights/aries/aries-builder.ts
 *
 * Fetches data for the "Working with Aries" section of the Insights dashboard.
 *
 * Returns:
 *   - approvalFlow: counts from campaign_learning_labels (approved/rejected/edited)
 *   - learnings:    empty until taste-signal / Honcho pipeline is wired to DB
 *   - learningCurve: weekly avg-attempts-to-approval from campaign_learning_labels
 *
 * Queries run sequentially (DB_POOL_MAX guardrail — no Promise.all on DB calls).
 */

import pool from '@/lib/db';
import type { NarrativePeriod } from '../narrative/snapshot-builder';

// ── Public shapes ─────────────────────────────────────────────────────────────

export interface ApprovalFlowSnapshot {
  drafts:                  number;
  firstTry:                number;
  edited:                  number;
  rebuilt:                 number;
  firstTryRate:            number;   // %
  firstTryRatePriorPeriod: number;   // % in the immediately preceding same-length period
  weeksOnAries:            number;
}

export interface AriesLearning {
  icon:  string;
  title: string;
  body:  string;
}

export interface LearningCurveSnapshot {
  labels: string[];   // week-start labels e.g. "Jun 5"
  values: number[];   // avg attempts to approval per week
}

export interface WorkingWithAriesSnapshot {
  approvalFlow:  ApprovalFlowSnapshot;
  learnings:     AriesLearning[];
  learningCurve: LearningCurveSnapshot;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function periodDays(period: NarrativePeriod): number {
  if (period === 'week')  return 7;
  if (period === '30day') return 30;
  return 90;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function formatWeekLabel(date: Date): string {
  return new Date(date).toLocaleDateString('en-US', {
    month:    'short',
    day:      'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Derives the three approval-outcome buckets from raw label counts.
 *
 * - rebuilt  = rejections that prompted a new draft (each 'rejected' label)
 * - edited   = 'needs_changes' labels (user tweaked before approving)
 * - firstTry = approved count minus rebuilt and edited (approved on first pass)
 *
 * All three are clamped to ≥ 0 so negative counts can't surface.
 */
function deriveFlowBuckets(
  approved: number,
  rejected: number,
  needsChanges: number,
): { firstTry: number; edited: number; rebuilt: number; drafts: number } {
  const rebuilt  = Math.min(rejected, approved);
  const edited   = Math.min(needsChanges, Math.max(0, approved - rebuilt));
  const firstTry = Math.max(0, approved - rebuilt - edited);
  // drafts = all decisions made (includes rejected drafts that were never re-approved)
  const drafts   = firstTry + edited + rebuilt + Math.max(0, rejected - rebuilt);
  return { firstTry, edited, rebuilt, drafts };
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildWorkingWithAriesSnapshot(
  tenantId: number,
  period:   NarrativePeriod,
): Promise<WorkingWithAriesSnapshot> {
  const days          = periodDays(period);
  const fromDate      = daysAgo(days);
  const priorFromDate = daysAgo(days * 2);

  const client = await pool.connect();
  try {

    // ── Query 1: current-period label counts ─────────────────────────────────
    const flowRes = await client.query<{
      approved_count:  string;
      rejected_count:  string;
      edited_count:    string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE label = 'approved')      AS approved_count,
         COUNT(*) FILTER (WHERE label = 'rejected')      AS rejected_count,
         COUNT(*) FILTER (WHERE label = 'needs_changes') AS edited_count
       FROM campaign_learning_labels
       WHERE tenant_id = $1
         AND created_at >= $2`,
      [tenantId, fromDate],
    );

    // ── Query 2: prior-period label counts (for firstTryRate comparison) ─────
    const priorFlowRes = await client.query<{
      approved_count:  string;
      rejected_count:  string;
      edited_count:    string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE label = 'approved')      AS approved_count,
         COUNT(*) FILTER (WHERE label = 'rejected')      AS rejected_count,
         COUNT(*) FILTER (WHERE label = 'needs_changes') AS edited_count
       FROM campaign_learning_labels
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at <  $3`,
      [tenantId, priorFromDate, fromDate],
    );

    // ── Query 3: organisation creation date (for weeksOnAries) ───────────────
    const orgRes = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM organizations WHERE id = $1`,
      [tenantId],
    );

    // ── Query 4: weekly label history for learning curve (last 12 weeks) ─────
    const curveRes = await client.query<{
      week_start: Date;
      approved:   string;
      rejected:   string;
      edited:     string;
    }>(
      `SELECT
         date_trunc('week', created_at)                            AS week_start,
         COUNT(*) FILTER (WHERE label = 'approved')                AS approved,
         COUNT(*) FILTER (WHERE label = 'rejected')                AS rejected,
         COUNT(*) FILTER (WHERE label = 'needs_changes')           AS edited
       FROM campaign_learning_labels
       WHERE tenant_id = $1
         AND created_at >= $2
         AND label IN ('approved', 'rejected', 'needs_changes')
       GROUP BY week_start
       ORDER BY week_start ASC`,
      [tenantId, daysAgo(84)],   // 12 weeks back
    );

    // ── Approval flow ─────────────────────────────────────────────────────────
    const approved  = Number(flowRes.rows[0].approved_count);
    const rejected  = Number(flowRes.rows[0].rejected_count);
    const needsChg  = Number(flowRes.rows[0].edited_count);
    const buckets   = deriveFlowBuckets(approved, rejected, needsChg);
    const firstTryRate = buckets.drafts > 0
      ? Math.round((buckets.firstTry / buckets.drafts) * 100)
      : 0;

    const priorApproved = Number(priorFlowRes.rows[0].approved_count);
    const priorRejected = Number(priorFlowRes.rows[0].rejected_count);
    const priorEdited   = Number(priorFlowRes.rows[0].edited_count);
    const priorBuckets  = deriveFlowBuckets(priorApproved, priorRejected, priorEdited);
    const firstTryRatePriorPeriod = priorBuckets.drafts > 0
      ? Math.round((priorBuckets.firstTry / priorBuckets.drafts) * 100)
      : 0;

    // ── Weeks on Aries ────────────────────────────────────────────────────────
    const orgCreatedAt  = orgRes.rows[0]?.created_at ?? new Date();
    const weeksOnAries  = Math.max(
      1,
      Math.floor((Date.now() - new Date(orgCreatedAt).getTime()) / (7 * 24 * 60 * 60 * 1000)),
    );

    // ── Learning curve ────────────────────────────────────────────────────────
    const curveLabels: string[] = [];
    const curveValues: number[] = [];

    for (const row of curveRes.rows) {
      const weekApproved = Number(row.approved);
      if (weekApproved === 0) continue;   // skip weeks with no approved outcomes
      const weekTotal    = weekApproved + Number(row.rejected) + Number(row.edited);
      curveLabels.push(formatWeekLabel(new Date(row.week_start)));
      curveValues.push(parseFloat((weekTotal / weekApproved).toFixed(1)));
    }

    return {
      approvalFlow: {
        drafts:                  buckets.drafts,
        firstTry:                buckets.firstTry,
        edited:                  buckets.edited,
        rebuilt:                 buckets.rebuilt,
        firstTryRate,
        firstTryRatePriorPeriod,
        weeksOnAries,
      },
      // Learnings are derived from Honcho preference memory and the
      // marketing_taste_signal / taste_profile pipeline, neither of which
      // is exposed as a local DB query yet. Return empty until that
      // pipeline writes a queryable learnings table.
      learnings: [],
      learningCurve: {
        labels: curveLabels,
        values: curveValues,
      },
    };

  } finally {
    client.release();
  }
}
