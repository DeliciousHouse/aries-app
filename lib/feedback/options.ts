/**
 * Feedback form option lists — the single source of truth for the Category and
 * Severity dropdowns. Kept free of any server-only imports (no `pg`, no env, no
 * `@/auth`) so the client widget and the API route can both import it and stay
 * in lockstep: the route validates against exactly the values the UI offers.
 *
 * Values come from the approved spec (Aries Dev Meeting — June 19, 2026):
 *   Category: Bug, Login issue, Feature idea, Content quality, Other
 *   Severity: Low, Medium, High, Blocker
 */

export const FEEDBACK_CATEGORIES = [
  'Bug',
  'Login issue',
  'Feature idea',
  'Content quality',
  'Other',
] as const;

export const FEEDBACK_SEVERITIES = ['Low', 'Medium', 'High', 'Blocker'] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return typeof value === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

export function isFeedbackSeverity(value: unknown): value is FeedbackSeverity {
  return typeof value === 'string' && (FEEDBACK_SEVERITIES as readonly string[]).includes(value);
}

/** Hard limits shared by the client (UX hints) and the server (enforcement). */
export const FEEDBACK_LIMITS = {
  /** Max comment length. Long enough for a detailed bug report, bounded for sanity. */
  commentMax: 5000,
  /** Max page-URL length stored/sent. */
  pageUrlMax: 2048,
  /** Max user-agent string length. */
  userAgentMax: 1024,
  /** Max number of recent console-error lines captured. */
  consoleErrorsMax: 25,
  /** Max length of a single captured console-error line. */
  consoleErrorLineMax: 2000,
  /** Max screenshot size in bytes (5 MB). */
  screenshotBytesMax: 5 * 1024 * 1024,
} as const;

/** Image MIME types accepted for the optional screenshot attachment. */
export const FEEDBACK_SCREENSHOT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
