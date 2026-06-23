/**
 * Pure helpers for turning an untrusted request body into a validated feedback
 * submission. No I/O — kept separate from the route so it is unit-testable.
 */

import { createHash, randomBytes } from 'node:crypto';

import {
  FEEDBACK_LIMITS,
  FEEDBACK_SCREENSHOT_MIME_TYPES,
  isFeedbackCategory,
  isFeedbackSeverity,
  type FeedbackCategory,
  type FeedbackSeverity,
} from './options';
import type { FeedbackClientContext } from './types';

// Require real entropy in a client-supplied id: it doubles as the screenshot
// access token and the idempotency/storage key, so a short, guessable id would
// let one submission's row/screenshot be addressed or clobbered by another.
// 16+ chars (the widget mints 16 hex = 64 bits) makes blind addressing infeasible.
const SUBMISSION_ID_RE = /^fb_[A-Za-z0-9_-]{16,64}$/;

/** Generate a server-side submission id when the client did not supply one. */
export function generateSubmissionId(): string {
  return `fb_${randomBytes(8).toString('hex')}`;
}

/** Accept a client id only if it matches the safe format; else mint one. */
export function normalizeSubmissionId(raw: unknown): string {
  return typeof raw === 'string' && SUBMISSION_ID_RE.test(raw) ? raw : generateSubmissionId();
}

/** SHA-256 of the client IP — we store the hash, never the raw address. */
export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex');
}

/**
 * Best-effort client IP for rate-limit bucketing: first x-forwarded-for hop,
 * falling back to x-real-ip. Header-derived IPs are spoofable, so this is one
 * input to throttling, not a trust boundary — header-less requests share a single
 * bucket (see countRecentSubmissions) rather than going unlimited.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  if (first) return first;
  return headers.get('x-real-ip')?.trim() || null;
}

function cleanString(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

// Query params that routinely carry credentials/PII. Their VALUES are redacted
// before a page URL is stored or mirrored to the Sheet — the feedback button
// mounts on auth/reset/OAuth pages where these can appear.
const SENSITIVE_URL_PARAM =
  /^(token|code|state|access_token|id_token|refresh_token|secret|password|pwd|api[_-]?key|key|jwt|auth|session|sig|signature|email)$/i;

/** Drop the fragment (can carry implicit-OAuth tokens) and redact secret params. */
export function sanitizePageUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAM.test(name)) url.searchParams.set(name, 'REDACTED');
    }
    url.hash = '';
    return url.toString();
  } catch {
    // Relative/garbage URL: strip fragment + query wholesale.
    return raw.split('#')[0].split('?')[0];
  }
}

// Best-effort scrubbing of secrets that may appear in captured console errors
// (JWTs, bearer/api-key assignments, long opaque tokens, emails) before they are
// persisted to the DB / shared Sheet. Defense-in-depth, not a guarantee.
const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
  /\bbearer\s+[^\s,;"']+/gi, // Bearer <token> (space-separated)
  /\b(token|api[_-]?key|secret|password|authorization|auth|key)\b["']?\s*[:=]\s*["']?[^\s,;"']+/gi, // key=value
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email
  /\b[A-Fa-f0-9]{32,}\b/g, // long hex tokens / hashes
];

export function redactSecrets(line: string): string {
  let out = line;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

export function normalizeClientContext(raw: unknown): FeedbackClientContext {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const consoleErrors = Array.isArray(obj.consoleErrors)
    ? obj.consoleErrors
        .filter((e): e is string => typeof e === 'string')
        .slice(-FEEDBACK_LIMITS.consoleErrorsMax)
        .map((e) => redactSecrets(e).slice(0, FEEDBACK_LIMITS.consoleErrorLineMax))
    : [];
  const rawUrl = cleanString(obj.pageUrl, FEEDBACK_LIMITS.pageUrlMax);
  return {
    pageUrl: rawUrl ? sanitizePageUrl(rawUrl).slice(0, FEEDBACK_LIMITS.pageUrlMax) : null,
    userAgent: cleanString(obj.userAgent, FEEDBACK_LIMITS.userAgentMax),
    viewport: cleanString(obj.viewport, 64),
    consoleErrors,
  };
}

export interface DecodedScreenshot {
  bytes: Buffer;
  mime: string;
}

export type ScreenshotParseResult =
  | { ok: true; screenshot: DecodedScreenshot | null }
  | { ok: false; error: string };

/**
 * Parse an optional screenshot from a data URL ("data:image/png;base64,...").
 * Returns ok:true with screenshot:null when none was sent; ok:false on a
 * malformed/oversized/unsupported image so the route can 422.
 */
export function parseScreenshot(raw: unknown): ScreenshotParseResult {
  if (raw == null) return { ok: true, screenshot: null };

  const dataUrl =
    typeof raw === 'string'
      ? raw
      : typeof (raw as { dataUrl?: unknown })?.dataUrl === 'string'
        ? (raw as { dataUrl: string }).dataUrl
        : null;
  if (!dataUrl) return { ok: false, error: 'screenshot_invalid' };

  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) return { ok: false, error: 'screenshot_invalid' };

  const mime = match[1].toLowerCase();
  if (!(FEEDBACK_SCREENSHOT_MIME_TYPES as readonly string[]).includes(mime)) {
    return { ok: false, error: 'screenshot_unsupported_type' };
  }

  // Reject oversized images by base64 length BEFORE decoding, so an over-limit
  // payload never allocates a multi-MB Buffer (base64 is ~4/3 the byte size).
  if (match[2].length > Math.ceil(FEEDBACK_LIMITS.screenshotBytesMax / 3) * 4 + 4) {
    return { ok: false, error: 'screenshot_too_large' };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2], 'base64');
  } catch {
    return { ok: false, error: 'screenshot_invalid' };
  }
  if (bytes.length === 0) return { ok: false, error: 'screenshot_invalid' };
  if (bytes.length > FEEDBACK_LIMITS.screenshotBytesMax) {
    return { ok: false, error: 'screenshot_too_large' };
  }
  return { ok: true, screenshot: { bytes, mime } };
}

export interface ValidatedSubmissionInput {
  submissionId: string;
  comment: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  context: FeedbackClientContext;
  screenshot: DecodedScreenshot | null;
}

export type ValidationResult =
  | { ok: true; value: ValidatedSubmissionInput }
  | { ok: false; fieldErrors: Record<string, string>; error: string };

/** Validate the parsed JSON body against the spec's required fields. */
export function validateSubmission(body: unknown): ValidationResult {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  const comment = cleanString(obj.comment, FEEDBACK_LIMITS.commentMax);
  if (!comment) fieldErrors.comment = 'A comment is required.';

  if (!isFeedbackCategory(obj.category)) fieldErrors.category = 'Choose a category.';
  if (!isFeedbackSeverity(obj.severity)) fieldErrors.severity = 'Choose a severity.';

  const screenshotResult = parseScreenshot(obj.screenshot);
  if (!screenshotResult.ok) fieldErrors.screenshot = screenshotResult.error;

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors, error: 'invalid_input' };
  }

  return {
    ok: true,
    value: {
      submissionId: normalizeSubmissionId(obj.submissionId),
      comment: comment as string,
      category: obj.category as FeedbackCategory,
      severity: obj.severity as FeedbackSeverity,
      context: normalizeClientContext(obj.context),
      screenshot: (screenshotResult as { ok: true; screenshot: DecodedScreenshot | null }).screenshot,
    },
  };
}
