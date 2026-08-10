/**
 * S4-6 / AA-109 (gap C4) — best-effort producer that turns a real operator
 * review decision into a `campaign_learning_labels` row.
 *
 * WHY: the "Working with Aries" insights section (approval-flow bar + learning
 * curve, `backend/insights/aries/aries-builder.ts`) reads this table, and until
 * now its ONLY writer was the manual Creative Memory labeling tool. A tenant who
 * never hand-labeled anything saw zeros — the section was dead for every real
 * tenant. The review tray is where the equivalent human judgement already
 * happens, so it becomes the second writer. The manual tool is unchanged and
 * keeps writing its own rows (`source='operator'`, `confidence_basis='manual_label'`);
 * these rows carry `source='marketing_review'` + `confidence_basis='review_decision'`,
 * so the two origins stay distinguishable forever.
 *
 * UNFLAGGED, deliberately — the roadmap's S4-6 row calls this out as acceptable
 * when stated: it is a writer into an EXISTING table from an EXISTING
 * human-action path, it adds no new surface, and a flag defaulting OFF would
 * ship the section still dead, which is the entire defect. It is additive
 * (label rows only), NULL-safe for every existing reader, and the write is
 * best-effort so it cannot fail the operator's decision. See the PR body's flag
 * decision line.
 *
 * Every write is wrapped + non-fatal, matching the taste-learning producer next
 * door (`review-edit-taste.ts`): a learning-label write must NEVER break an
 * operator action.
 */
import pool from '@/lib/db';

/** Labels the "Working with Aries" builder actually reads. */
export type MarketingReviewLearningLabel = 'approved' | 'rejected' | 'needs_changes';

type LearningLabelDeps = {
  /** Override the writer (tests). Defaults to the shared pool. */
  query?: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
};

/**
 * Decide the learning label for a per-item review decision, at the
 * `recordMarketingReviewDecision` call site. Pure + side-effect-free so the
 * double-count guard is unit-testable in isolation.
 *
 * Returns a label ONLY for a creative item that carries an assetId (a real
 * per-asset decision). Returns null for everything else:
 *  - non-creative review types (strategy / brand / workflow_approval), and
 *  - publish-preview launch-gate items, which also carry reviewType 'creative'
 *    but NO assetId — labeling those would count the same creative twice, once
 *    in the review tray and again at the publish gate, inflating the approval
 *    flow bar and flattening the learning curve.
 * This is the same discrimination `creativeReviewTasteOutcome` makes, for the
 * same reason.
 *
 * NOTE the mapping differs from the taste producer's on purpose. Taste collapses
 * changes_requested into 'rejected' because it only has two outcomes; the
 * approval-flow bar distinguishes them — 'needs_changes' is the EDITED bucket
 * (operator tweaked, then approved) and 'rejected' is the REBUILT bucket
 * (draft thrown away). Collapsing them here would erase the edited bar entirely.
 */
export function creativeReviewLearningLabel(
  item: { reviewType?: string | null | undefined; assetId?: string | null | undefined },
  action: string,
): MarketingReviewLearningLabel | null {
  if (item.reviewType !== 'creative' || !item.assetId) return null;
  if (action === 'approve') return 'approved';
  if (action === 'reject') return 'rejected';
  if (action === 'changes_requested') return 'needs_changes';
  return null;
}

/**
 * Deterministic idempotency key for a marketing-review label.
 *
 * Keyed on (job, asset, label) — NOT on a timestamp — so a double-clicked or
 * re-delivered decision collapses onto one row via ON CONFLICT DO NOTHING, while
 * a genuine change of mind still records a second attempt. That is exactly what
 * the learning curve measures: a creative that went changes_requested → approved
 * writes two rows and reads as 2.0 attempts-to-approval, whereas one approved on
 * the first pass writes one row and reads as 1.0.
 */
export function marketingReviewLabelIdempotencyKey(
  jobId: string,
  assetId: string,
  label: MarketingReviewLearningLabel,
): string {
  return `marketing-review:${jobId}:${assetId}:${label}`;
}

/**
 * Write one learning label from a marketing review decision.
 *
 * Returns true when a row was written or already existed (idempotent replay),
 * false when the input was unusable or the write failed and was swallowed.
 * Never throws.
 *
 * Single `pool.query` — no pooled client is held across the operator's request
 * (guardrail #1).
 */
export async function recordMarketingReviewLearningLabel(
  input: {
    tenantId: string | number;
    jobId: string;
    assetId: string;
    label: MarketingReviewLearningLabel;
    note?: string | null;
  },
  deps: LearningLabelDeps = {},
): Promise<boolean> {
  const tenantId = Number(input.tenantId);
  const jobId = String(input.jobId ?? '').trim();
  const assetId = String(input.assetId ?? '').trim();

  // tenant_id is INTEGER REFERENCES organizations(id); a non-numeric tenant
  // would fail the insert, so drop it here rather than log a DB error per click.
  if (!Number.isSafeInteger(tenantId) || tenantId < 1 || !jobId || !assetId) return false;

  const query = deps.query ?? ((text, values) => pool.query(text, values));

  try {
    await query(
      `INSERT INTO campaign_learning_labels
         (tenant_id, idempotency_key, label, marketing_job_id, marketing_asset_id,
          note, source, confidence_basis)
       VALUES ($1, $2, $3, $4, $5, $6, 'marketing_review', 'review_decision')
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [
        tenantId,
        marketingReviewLabelIdempotencyKey(jobId, assetId, input.label),
        input.label,
        jobId,
        assetId,
        input.note?.trim() || null,
      ],
    );
    return true;
  } catch (err) {
    console.warn('[review-learning-labels] label write failed (non-fatal)', {
      tenantId,
      jobId,
      label: input.label,
      error: (err as Error)?.message ?? String(err),
    });
    return false;
  }
}
