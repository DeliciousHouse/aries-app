/**
 * Shared, provider-agnostic errors for the integration layer.
 * Composio-specific errors live in ../composio/errors.ts and extend these.
 */

export class IntegrationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, message: string, options?: { status?: number; retryable?: boolean }) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
    this.status = options?.status ?? 400;
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Thrown when a live (non-dry-run) publish is attempted without an approval.
 * This is the code-level enforcement of "no live posting unless the existing
 * Aries approval flow has approved it".
 */
export class PublishGuardError extends IntegrationError {
  constructor(message = 'A live publish requires an approved request. Pass `approved: true` only after the Aries approval flow has cleared it, or set `dryRun: true` to preview.') {
    super('live_publish_requires_approval', message, { status: 409 });
    this.name = 'PublishGuardError';
  }
}

/** Thrown when no provider can service a platform/operation. */
export class ProviderUnavailableError extends IntegrationError {
  constructor(code: string, message: string) {
    super(code, message, { status: 503 });
    this.name = 'ProviderUnavailableError';
  }
}
