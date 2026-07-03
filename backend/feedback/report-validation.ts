/**
 * Pure request validation for POST /api/feedback/submit (SC-70 port). No I/O.
 *
 * INVARIANT (SC-70): identity comes from the session only. This validator
 * reads exactly category/impact/title/description/screenshot from the body —
 * submitter/tenant/priority fields a client smuggles in are never read, so
 * they cannot influence the persisted row, the labels, or the ADF.
 */

import {
  FEEDBACK_REPORT_LIMITS,
  isFeedbackImpact,
  isFeedbackReportCategory,
  type FeedbackImpact,
  type FeedbackReportCategory,
} from './report-options';

export interface ValidatedReportRequest {
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

export function validateReportRequest(body: unknown): ReportRequestValidation {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

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
      category,
      impact: obj.impact as FeedbackImpact,
      title,
      description,
      screenshot: obj.screenshot ?? null,
    },
  };
}
