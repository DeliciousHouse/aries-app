/** Composio-specific errors, extending the shared integration error base. */

import { IntegrationError } from '../providers/errors';

export class ComposioError extends IntegrationError {
  constructor(code: string, message: string, options?: { status?: number; retryable?: boolean }) {
    super(code, message, options);
    this.name = 'ComposioError';
  }
}

/** Composio is selected but not configured (missing API key / auth config). */
export class ComposioConfigError extends ComposioError {
  constructor(message: string) {
    super('composio_not_configured', message, { status: 503 });
    this.name = 'ComposioConfigError';
  }
}

/** The SDK package is selected but not installed in this deployment. */
export class ComposioSdkMissingError extends ComposioError {
  constructor() {
    super(
      'composio_sdk_missing',
      'Composio is enabled but the @composio/core package is not installed. Run `npm i @composio/core` or set COMPOSIO_ENABLED=false.',
      { status: 503 },
    );
    this.name = 'ComposioSdkMissingError';
  }
}

/** No ACTIVE connected account exists for this tenant/platform. */
export class ComposioConnectionMissingError extends ComposioError {
  constructor(platform: string) {
    super('composio_connection_missing', `No active Composio connection for ${platform}. Connect the account first.`, {
      status: 409,
    });
    this.name = 'ComposioConnectionMissingError';
  }
}

/** The connection exists but lacks the capability required for the operation. */
export class ComposioCapabilityMissingError extends ComposioError {
  constructor(platform: string, capability: string) {
    super(
      'composio_capability_missing',
      `The connected ${platform} account cannot ${capability}. Reconnect granting the required permissions.`,
      { status: 403 },
    );
    this.name = 'ComposioCapabilityMissingError';
  }
}

/** A Composio tool execution returned an error / unsuccessful result. */
export class ComposioToolError extends ComposioError {
  constructor(slug: string, message: string) {
    super('composio_tool_error', `Composio tool ${slug} failed: ${message}`, { status: 502, retryable: true });
    this.name = 'ComposioToolError';
  }
}
