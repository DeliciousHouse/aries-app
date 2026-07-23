/**
 * Pure client-side logic for the customer incident report dialog (SC-70 port).
 * No React, no DOM — unit-tested directly. The component in report-dialog.tsx
 * is a thin shell over these helpers.
 */

import {
  FEEDBACK_REPORT_LIMITS,
  FEEDBACK_REPORT_SCREENSHOT_MIMES,
  base64DecodedBytes,
  type FeedbackImpact,
  type FeedbackReportCategory,
} from '@/lib/feedback/report-options';

/**
 * INVARIANT (SC-70): the success link is a fixed https prefix + the
 * server-returned key ONLY — user input never reaches the href. The key is
 * additionally shape-validated before interpolation.
 */
export const JIRA_BROWSE_PREFIX = 'https://sugarandleather.atlassian.net/browse/';

const TICKET_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export function ticketUrlForKey(key: string): string | null {
  return TICKET_KEY_RE.test(key) ? `${JIRA_BROWSE_PREFIX}${key}` : null;
}

export interface ReportFormValues {
  impact: FeedbackImpact | null;
  category: FeedbackReportCategory;
  title: string;
  description: string;
}

/** Client-side validation mirroring the server rules (no raw 422s for users). */
export function validateReportForm(values: ReportFormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values.impact) errors.impact = 'Choose how badly this affects you.';
  const title = values.title.trim();
  if (title.length < 1) errors.title = 'A title is required.';
  else if (title.length > FEEDBACK_REPORT_LIMITS.titleMax) {
    errors.title = `Title must be at most ${FEEDBACK_REPORT_LIMITS.titleMax} characters.`;
  }
  const description = values.description.trim();
  if (description.length < 1) errors.description = 'A description is required.';
  else if (description.length > FEEDBACK_REPORT_LIMITS.descriptionMax) {
    errors.description = `Description must be at most ${FEEDBACK_REPORT_LIMITS.descriptionMax} characters.`;
  }
  return errors;
}

export interface ReportScreenshotPayload {
  base64: string;
  mime: string;
}

/**
 * Turn a data URL into the { base64, mime } POST payload, enforcing the
 * client-side cap (decoded size computed from base64 length — no decode) and
 * the mime whitelist. Returns an error string for the inline message.
 */
export function screenshotPayloadFromDataUrl(
  dataUrl: string,
  maxBytes: number = FEEDBACK_REPORT_LIMITS.screenshotBytesMax,
): { ok: true; payload: ReportScreenshotPayload } | { ok: false; error: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) return { ok: false, error: 'That image could not be read.' };
  const mime = match[1].toLowerCase();
  if (!(FEEDBACK_REPORT_SCREENSHOT_MIMES as readonly string[]).includes(mime)) {
    return { ok: false, error: 'Screenshot must be a PNG, JPEG, or WebP image.' };
  }
  if (base64DecodedBytes(match[2]) > maxBytes) {
    return {
      ok: false,
      error: `Screenshot must be ${Math.floor(maxBytes / 1_000_000)} MB or smaller.`,
    };
  }
  return { ok: true, payload: { base64: match[2], mime } };
}

/**
 * INVARIANT (SC-70): the POST body carries only the report content plus the
 * opaque retry key — no identity, tenant, or priority fields. The server
 * derives identity from the session and priority from the impact.
 */
export function buildReportSubmitBody(
  values: ReportFormValues,
  screenshot: ReportScreenshotPayload | null,
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    idempotency_key: idempotencyKey,
    impact: values.impact,
    category: values.category,
    title: values.title.trim(),
    description: values.description.trim(),
    screenshot,
  };
}

export type ReportOutcome =
  | { kind: 'success'; message: string; ticketKey: string | null; ticketUrl: string | null }
  | { kind: 'received'; message: string }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'error'; message: string };

function discardNote(reason: string | null | undefined): string {
  if (!reason) return '';
  if (reason === 'too_large') return ' The screenshot was too large and was not attached.';
  if (reason === 'unsupported_type') {
    return ' The screenshot type is not supported and was not attached.';
  }
  return ' The screenshot could not be read and was not attached.';
}

/**
 * Map the server response to dialog UX per the SC-70 contract:
 *  - 201 + key → success with a browse link (delivery may still reconcile).
 *  - 202 → received/syncing.
 *  - 429 → keep the dialog open with values intact and show the server message.
 *  - anything else → generic retryable failure, dialog stays open.
 */
export function outcomeFromResponse(
  status: number,
  body: {
    jira_ticket_key?: unknown;
    status?: unknown;
    screenshot_discarded?: unknown;
    error?: unknown;
  } | null,
): ReportOutcome {
  const discarded = typeof body?.screenshot_discarded === 'string' ? body.screenshot_discarded : null;

  if (status === 201 && typeof body?.jira_ticket_key === 'string') {
    const key = body.jira_ticket_key;
    const syncing = body?.status === 'pending_retry' ? ' Delivery is still reconciling.' : '';
    return {
      kind: 'success',
      message: `Thanks — filed as ${key}.${syncing}${discardNote(discarded)}`,
      ticketKey: key,
      ticketUrl: ticketUrlForKey(key),
    };
  }
  if (status === 201 || status === 202) {
    return {
      kind: 'received',
      message: `Report received — syncing to our tracker.${discardNote(discarded)}`,
    };
  }
  if (status === 429) {
    return {
      kind: 'rate_limited',
      message:
        typeof body?.error === 'string'
          ? body.error
          : 'Too many reports right now. Please try again shortly.',
    };
  }
  return {
    kind: 'error',
    message:
      body?.status === 'failed' && typeof body.error === 'string'
        ? body.error
        : "We couldn't send that just now. Your text is saved — please retry.",
  };
}
