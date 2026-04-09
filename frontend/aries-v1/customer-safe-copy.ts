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
