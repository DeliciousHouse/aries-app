export function customerSafeUiErrorMessage(
  message: string | null | undefined,
  fallback = 'This section is not available right now.',
): string {
  const normalized = typeof message === 'string' ? message.trim() : '';
  if (!normalized) {
    return fallback;
  }

  if (/authentication required|unauthorized|forbidden|tenant_context_required/i.test(normalized)) {
    return 'Your session is no longer active. Sign in again to continue.';
  }

  if (/review_not_found|job_not_found|not found/i.test(normalized)) {
    return 'This item is not available in the current workspace.';
  }

  if (
    /meta_app_secret|oauth_token_encryption_key|client_secret|client_id|missing env|stack|trace|oauth|provider_unavailable|internal_error|validation_error/i.test(
      normalized,
    )
  ) {
    return fallback;
  }

  if (normalized.length > 220) {
    return fallback;
  }

  return normalized;
}

export function customerSafeActionErrorMessage(
  message: string | null | undefined,
  fallback = 'That change could not be saved right now.',
): string {
  return customerSafeUiErrorMessage(message, fallback);
}

/**
 * Machine codes the onboarding/profile APIs return in `{ "error": "..." }`.
 * These reach the UI as `ApiRequestError.message`, and several surfaces used to
 * render them verbatim — a user saving their profile could be shown the literal
 * text `brand_kit_fetch_failed` or `draft_not_found` with no explanation and no
 * recovery action. Each code maps to something that says what happened and what
 * to do about it.
 */
const PROFILE_API_ERROR_COPY: ReadonlyArray<{ pattern: RegExp; copy: string }> = [
  {
    pattern: /brand_kit_fetch_failed/i,
    copy:
      'We could not read that website automatically — sites behind bot protection (such as Cloudflare) block our reader. Your details are saved; you can fill in the brand information by hand.',
  },
  {
    pattern: /draft_not_found/i,
    copy: 'That saved setup has expired. Your answers on screen are kept — continue and we will start a fresh session.',
  },
  {
    pattern: /onboarding_draft_unavailable|database_unavailable/i,
    copy: 'We could not reach Aries just now. Your answers are kept in this browser — try again in a moment.',
  },
  {
    pattern: /missing_required_fields/i,
    copy: 'Some required details are still missing. Check the highlighted fields and try again.',
  },
  {
    pattern: /multi_workspace_requires_pro/i,
    copy: 'Your plan includes one workspace. Contact the Aries team to add another.',
  },
];

/**
 * Turn an API error code into customer-facing copy, falling back to the generic
 * sanitizer for anything unrecognized (which also strips internals and
 * over-long strings).
 */
export function profileApiErrorMessage(
  message: string | null | undefined,
  fallback = 'That change could not be saved right now.',
): string {
  const normalized = typeof message === 'string' ? message.trim() : '';
  if (!normalized) {
    return fallback;
  }

  for (const { pattern, copy } of PROFILE_API_ERROR_COPY) {
    if (pattern.test(normalized)) {
      return copy;
    }
  }

  // Anything still shaped like a machine code (snake_case, no spaces) is an
  // internal identifier we have not mapped — never show it raw.
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(normalized)) {
    return fallback;
  }

  return customerSafeActionErrorMessage(normalized, fallback);
}
