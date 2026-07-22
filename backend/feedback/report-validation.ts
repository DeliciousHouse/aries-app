/**
 * Pure request validation for POST /api/feedback/submit (SC-70 port). No I/O.
 *
 * INVARIANT (SC-70): identity comes from server context only (session when
 * present, otherwise an IP-hashed anonymous identity). This validator reads
 * exactly idempotency_key/category/impact/title/description/screenshot from
 * the body — client submitter/tenant/priority fields are never read.
 */

import {
  FEEDBACK_REPORT_LIMITS,
  isFeedbackImpact,
  isFeedbackReportCategory,
  type FeedbackImpact,
  type FeedbackReportCategory,
} from '@/lib/feedback/report-options';

export interface ValidatedReportRequest {
  idempotencyKey: string;
  category: FeedbackReportCategory;
  impact: FeedbackImpact;
  title: string;
  description: string;
  /** Raw screenshot payload — validated separately with discard (not 422) semantics. */
  screenshot: unknown;
}

export type ReportRequestValidation =
  | { ok: true; value: ValidatedReportRequest }
  | { ok: false; error: 'invalid_input'; fieldErrors: Record<string, string> };

const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateReportRequest(body: unknown): ReportRequestValidation {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  const idempotencyKey = typeof obj.idempotency_key === 'string' ? obj.idempotency_key : '';
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    fieldErrors.idempotency_key = 'A valid submission key is required.';
  }

  if (!isFeedbackImpact(obj.impact)) {
    fieldErrors.impact = 'Choose how badly this affects you.';
  }

  // The dialog defaults category to "bug"; an absent field gets the same
  // default, an invalid one is rejected.
  let category: FeedbackReportCategory = 'bug';
  if (obj.category !== undefined && obj.category !== null) {
    if (isFeedbackReportCategory(obj.category)) {
      category = obj.category;
    } else {
      fieldErrors.category = 'Choose a category.';
    }
  }

  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (title.length < 1) {
    fieldErrors.title = 'A title is required.';
  } else if (title.length > FEEDBACK_REPORT_LIMITS.titleMax) {
    fieldErrors.title = `Title must be at most ${FEEDBACK_REPORT_LIMITS.titleMax} characters.`;
  }

  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  if (description.length < 1) {
    fieldErrors.description = 'A description is required.';
  } else if (description.length > FEEDBACK_REPORT_LIMITS.descriptionMax) {
    fieldErrors.description = `Description must be at most ${FEEDBACK_REPORT_LIMITS.descriptionMax} characters.`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'invalid_input', fieldErrors };
  }

  return {
    ok: true,
    value: {
      idempotencyKey,
      category,
      impact: obj.impact as FeedbackImpact,
      title,
      description,
      screenshot: obj.screenshot ?? null,
    },
  };
}
