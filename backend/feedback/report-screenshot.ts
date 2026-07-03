/**
 * Screenshot validation for customer incident reports (SC-70 port). Pure.
 *
 * INVARIANT (SC-70): a bad/oversized image NEVER sinks the report — validation
 * returns a discard reason instead of throwing or 4xx-ing, and the caller saves
 * the report without the image.
 *
 * INVARIANT (SC-70): the pre-decode cap rejects an oversized base64 payload by
 * STRING LENGTH, before any decode allocates a multi-MB Buffer (memory-abuse
 * guard). Only payloads under the cap are ever decoded.
 */

import { FEEDBACK_REPORT_SCREENSHOT_MIMES } from './report-options';

export type ScreenshotDiscardReason =
  | 'too_large'
  | 'unsupported_type'
  | 'invalid_base64'
  | 'invalid_payload';

export type ScreenshotValidationResult =
  | { ok: true; screenshot: { bytes: Buffer; mime: string } | null; discarded: null }
  | { ok: true; screenshot: null; discarded: ScreenshotDiscardReason };

/** Base64 string length ceiling for a decoded payload of maxBytes. */
export function preDecodeBase64Cap(maxBytes: number): number {
  return Math.floor((4 * maxBytes + 2) / 3) + 4;
}

// Strict base64: canonical alphabet, optional padding, length divisible by 4.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Validate an optional screenshot payload ({ base64, mime } or null/undefined).
 * Never throws. Order matters: pre-decode length cap FIRST (no decode), then
 * mime whitelist, then strict decode, then the decoded-size cap.
 */
export function validateReportScreenshot(
  raw: unknown,
  maxBytes: number,
): ScreenshotValidationResult {
  if (raw == null) return { ok: true, screenshot: null, discarded: null };

  const obj = raw as { base64?: unknown; mime?: unknown };
  const base64 = typeof obj.base64 === 'string' ? obj.base64.trim() : null;
  const mime = typeof obj.mime === 'string' ? obj.mime.trim().toLowerCase() : null;
  if (!base64 || !mime) {
    return { ok: true, screenshot: null, discarded: 'invalid_payload' };
  }

  // 1) Pre-decode cap — string length only, nothing is decoded past here for
  // an oversized payload.
  if (base64.length > preDecodeBase64Cap(maxBytes)) {
    return { ok: true, screenshot: null, discarded: 'too_large' };
  }

  // 2) MIME whitelist.
  if (!(FEEDBACK_REPORT_SCREENSHOT_MIMES as readonly string[]).includes(mime)) {
    return { ok: true, screenshot: null, discarded: 'unsupported_type' };
  }

  // 3) Strict base64 decode.
  if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) {
    return { ok: true, screenshot: null, discarded: 'invalid_base64' };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return { ok: true, screenshot: null, discarded: 'invalid_base64' };
  }
  if (bytes.length === 0) {
    return { ok: true, screenshot: null, discarded: 'invalid_base64' };
  }

  // 4) Decoded-size cap (belt over the pre-decode estimate).
  if (bytes.length > maxBytes) {
    return { ok: true, screenshot: null, discarded: 'too_large' };
  }

  return { ok: true, screenshot: { bytes, mime }, discarded: null };
}

/** Attachment filename for the Jira upload, derived from the mime type. */
export function screenshotFilename(reportId: string, mime: string): string {
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return `screenshot-${reportId}.${ext}`;
}
