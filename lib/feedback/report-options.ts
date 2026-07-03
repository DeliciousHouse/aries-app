/**
 * Customer incident report (feedback v2) option lists — the single source of
 * truth shared by the client dialog and the server validators, mirroring the
 * lib/feedback/options.ts pattern. Kept free of server-only imports (no `pg`,
 * no env, no `@/auth`) so the widget can import it directly.
 *
 * Port of Sequence CRM SC-70 (see docs/plans/2026-07-03-customer-incident-button.md).
 * The five impact values and their order are part of the cross-product contract
 * and must not be reworded server-side without coordinating the Jira priority
 * scheme mapping.
 */

export const FEEDBACK_IMPACTS = [
  'p0_system_blocked',
  'p1_account_blocked',
  'p2_feature_degraded',
  'p3_minor_glitch',
  'p4_question',
] as const;

export type FeedbackImpact = (typeof FEEDBACK_IMPACTS)[number];

/** Impact options in display order — impact is asked FIRST, with no default. */
export const FEEDBACK_IMPACT_OPTIONS: ReadonlyArray<{ value: FeedbackImpact; label: string }> = [
  { value: 'p0_system_blocked', label: 'Entire team/system is blocked' },
  { value: 'p1_account_blocked', label: 'My account is blocked, others are OK' },
  { value: 'p2_feature_degraded', label: 'A feature is degraded/broken' },
  { value: 'p3_minor_glitch', label: 'Minor glitch/cosmetic issue' },
  { value: 'p4_question', label: 'General question/feedback' },
];

export const FEEDBACK_REPORT_CATEGORIES = ['bug', 'question', 'other'] as const;

export type FeedbackReportCategory = (typeof FEEDBACK_REPORT_CATEGORIES)[number];

export function isFeedbackImpact(value: unknown): value is FeedbackImpact {
  return typeof value === 'string' && (FEEDBACK_IMPACTS as readonly string[]).includes(value);
}

export function isFeedbackReportCategory(value: unknown): value is FeedbackReportCategory {
  return (
    typeof value === 'string' && (FEEDBACK_REPORT_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Hard limits shared by the client (UX hints) and the server (enforcement). */
export const FEEDBACK_REPORT_LIMITS = {
  titleMax: 255,
  descriptionMax: 10_000,
  /** Default decoded screenshot cap (bytes); server honors FEEDBACK_MAX_IMAGE_BYTES. */
  screenshotBytesMax: 2_000_000,
} as const;

/** Image MIME types accepted for the optional screenshot (v2: no gif). */
export const FEEDBACK_REPORT_SCREENSHOT_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Decoded byte size of a base64 string WITHOUT decoding it:
 * floor(len * 3 / 4) minus padding. Used by the client for the inline over-cap
 * check and by the server's pre-decode memory-abuse guard.
 */
export function base64DecodedBytes(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}
