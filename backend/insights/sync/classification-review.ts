/**
 * backend/insights/sync/classification-review.ts
 *
 * AA-90 (S1-11, gap B1) — the LABEL-QUALITY GATE.
 *
 * AA-90's real instruction was never "flip a flag" (the flag ships on): it was
 * "manually review the first classified batch" before five surfaces —
 * Conversations, Goal leads, Attention, Top, Trends — start treating machine
 * labels as fact. Until now that review had no tooling, so it meant hand-written
 * SQL, which is why it was never actually done.
 *
 * Why reviewing matters more than usual here: labels are written
 * ON CONFLICT DO NOTHING against a pinned classifier_version, so a bad batch
 * does NOT self-heal, and turning the flag back off does NOT roll it back. The
 * only remedy is a classifier_version bump to re-drive the S4-3 re-classify
 * sweep. Catching a bad prompt on batch one is therefore much cheaper than
 * catching it later.
 *
 * Pure read model: SELECTs only. Split from the CLI so the shaping and the
 * quality heuristics are testable without a database.
 */

export const REVIEW_SAMPLE_DEFAULT = 20;
export const REVIEW_SAMPLE_MAX = 200;

export interface ClassificationQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface ClassifiedCommentRow {
  commentId: number;
  tenantId: number;
  platform: string;
  receivedAt: string | null;
  bodyText: string;
  sentiment: string | null;
  isLead: boolean | null;
  category: string | null;
  classifierVersion: string;
  classifiedAt: string | null;
}

/** $1 tenant-or-null, $2 limit. Newest labels first — a review reads the most recent batch. */
export const REVIEW_SAMPLE_SQL = `
  SELECT
    c.id                 AS comment_id,
    c.tenant_id          AS tenant_id,
    c.platform           AS platform,
    c.received_at        AS received_at,
    c.body_text          AS body_text,
    k.sentiment          AS sentiment,
    k.is_lead            AS is_lead,
    k.category           AS category,
    k.classifier_version AS classifier_version,
    k.classified_at      AS classified_at
  FROM insights_comment_classifications k
  JOIN insights_comments c ON c.id = k.comment_id
  WHERE ($1::int IS NULL OR k.tenant_id = $1)
  ORDER BY k.classified_at DESC, k.comment_id DESC
  LIMIT $2
`;

/** $1 tenant-or-null. Coverage + distribution, for the summary line. */
export const REVIEW_SUMMARY_SQL = `
  SELECT
    (SELECT count(*) FROM insights_comments
      WHERE ($1::int IS NULL OR tenant_id = $1))::int                        AS comments_total,
    (SELECT count(*) FROM insights_comment_classifications
      WHERE ($1::int IS NULL OR tenant_id = $1))::int                        AS classified_total,
    count(*) FILTER (WHERE k.sentiment = 'positive')::int                    AS positive,
    count(*) FILTER (WHERE k.sentiment = 'neutral')::int                     AS neutral,
    count(*) FILTER (WHERE k.sentiment = 'negative')::int                    AS negative,
    count(*) FILTER (WHERE k.sentiment IS NULL)::int                         AS sentiment_null,
    count(*) FILTER (WHERE k.is_lead)::int                                   AS leads,
    count(*) FILTER (WHERE k.category = 'question')::int                     AS question,
    count(*) FILTER (WHERE k.category = 'compliment')::int                   AS compliment,
    count(*) FILTER (WHERE k.category = 'complaint')::int                    AS complaint,
    count(*) FILTER (WHERE k.category = 'spam')::int                         AS spam,
    count(*) FILTER (WHERE k.category = 'other')::int                        AS other,
    count(*) FILTER (WHERE k.category IS NULL)::int                          AS category_null,
    count(DISTINCT k.classifier_version)::int                                AS version_count
  FROM insights_comment_classifications k
  WHERE ($1::int IS NULL OR k.tenant_id = $1)
`;

export interface ClassificationSummary {
  commentsTotal: number;
  classifiedTotal: number;
  sentiment: { positive: number; neutral: number; negative: number; unlabelled: number };
  category: Record<string, number>;
  leads: number;
  versionCount: number;
}

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function shapeSummary(row: Record<string, unknown> | undefined): ClassificationSummary {
  return {
    commentsTotal: toInt(row?.comments_total),
    classifiedTotal: toInt(row?.classified_total),
    sentiment: {
      positive: toInt(row?.positive),
      neutral: toInt(row?.neutral),
      negative: toInt(row?.negative),
      unlabelled: toInt(row?.sentiment_null),
    },
    category: {
      question: toInt(row?.question),
      compliment: toInt(row?.compliment),
      complaint: toInt(row?.complaint),
      spam: toInt(row?.spam),
      other: toInt(row?.other),
      unlabelled: toInt(row?.category_null),
    },
    leads: toInt(row?.leads),
    versionCount: toInt(row?.version_count),
  };
}

export type ReviewVerdict = 'no_labels' | 'needs_review' | 'suspect';

export interface ReviewAssessment {
  verdict: ReviewVerdict;
  /** Human-readable reasons; empty for a clean `needs_review`. */
  warnings: string[];
}

/**
 * Mechanical smells only — this NEVER returns "good".
 *
 * The gate is a human reading labels next to their comment text; a script
 * cannot judge whether "love this!" was correctly called positive. What it CAN
 * do is surface the shapes that mean the classifier is not really working, so a
 * reviewer is not lulled by a table that merely has rows in it.
 *
 * Hence the verdict vocabulary: `needs_review` is the BEST outcome, because
 * a human still has to look.
 */
export function assessLabels(summary: ClassificationSummary): ReviewAssessment {
  if (summary.classifiedTotal === 0) {
    return {
      verdict: 'no_labels',
      warnings:
        summary.commentsTotal > 0
          ? [
              `${summary.commentsTotal} comments exist but NONE are classified — check the ` +
                'insights_classifier_preflight line; an unreachable gateway looks exactly like this.',
            ]
          : ['No comments have been fetched yet, so there is nothing to classify.'],
    };
  }

  const warnings: string[] = [];
  const { sentiment, category, classifiedTotal } = summary;

  // Every label identical is the classic broken-prompt signature: the model
  // answered, so nothing errored, but it is not discriminating.
  const sentimentValues = [sentiment.positive, sentiment.neutral, sentiment.negative];
  if (sentimentValues.some((n) => n === classifiedTotal) && classifiedTotal > 1) {
    warnings.push('Every comment received the SAME sentiment — the prompt is likely not discriminating.');
  }
  const categoryCounts = Object.entries(category).filter(([k]) => k !== 'unlabelled');
  if (categoryCounts.some(([, n]) => n === classifiedTotal) && classifiedTotal > 1) {
    warnings.push('Every comment received the SAME category — the prompt is likely not discriminating.');
  }

  // A NULL label means the model answered with something outside the pinned
  // vocabulary. A few are tolerable; a majority means the contract is not holding.
  if (sentiment.unlabelled > classifiedTotal / 2) {
    warnings.push(
      `${sentiment.unlabelled}/${classifiedTotal} rows have NO sentiment — the model is answering outside the pinned vocabulary.`,
    );
  }
  if (category.unlabelled > classifiedTotal / 2) {
    warnings.push(
      `${category.unlabelled}/${classifiedTotal} rows have NO category — the model is answering outside the pinned vocabulary.`,
    );
  }

  // Everything is a lead ⇒ the goal_type=lead_generation surface becomes noise.
  if (summary.leads === classifiedTotal && classifiedTotal > 1) {
    warnings.push('EVERY comment was marked a lead — the Goal "leads" count would be meaningless.');
  }

  if (summary.versionCount > 1) {
    warnings.push(
      `${summary.versionCount} classifier versions present — labels are mid-migration; review the newest version only.`,
    );
  }

  return { verdict: warnings.length > 0 ? 'suspect' : 'needs_review', warnings };
}

export async function loadClassificationSummary(
  db: ClassificationQueryable,
  tenantId: number | null,
): Promise<ClassificationSummary> {
  const { rows } = await db.query<Record<string, unknown>>(REVIEW_SUMMARY_SQL, [tenantId]);
  return shapeSummary(rows[0]);
}

export async function loadClassifiedSample(
  db: ClassificationQueryable,
  tenantId: number | null,
  limit: number,
): Promise<ClassifiedCommentRow[]> {
  const cap = Math.min(Math.max(Math.trunc(limit) || REVIEW_SAMPLE_DEFAULT, 1), REVIEW_SAMPLE_MAX);
  const { rows } = await db.query<Record<string, unknown>>(REVIEW_SAMPLE_SQL, [tenantId, cap]);
  return rows.map((r) => ({
    commentId: toInt(r.comment_id),
    tenantId: toInt(r.tenant_id),
    platform: String(r.platform ?? 'unknown'),
    receivedAt: r.received_at ? String(r.received_at) : null,
    bodyText: String(r.body_text ?? ''),
    sentiment: (r.sentiment as string | null) ?? null,
    isLead: (r.is_lead as boolean | null) ?? null,
    category: (r.category as string | null) ?? null,
    classifierVersion: String(r.classifier_version ?? ''),
    classifiedAt: r.classified_at ? String(r.classified_at) : null,
  }));
}
