/**
 * Provider-neutral execution error.
 *
 * Aries-owned counterpart to provider-specific errors (e.g. OpenClaw's
 * OpenClawGatewayError). Callers in the Hermes-native execution path should
 * surface this type so we can swap providers without changing the public
 * contract.
 */

export type ExecutionErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'unreachable'
  | 'tool_unavailable'
  | 'request_invalid'
  | 'response_invalid'
  | 'server_error';

export type ExecutionProviderName = 'openclaw' | 'hermes' | (string & {});

export interface ExecutionErrorInit {
  provider: ExecutionProviderName;
  code: ExecutionErrorCode;
  message: string;
  status?: number;
  cause?: unknown;
}

export class ExecutionError extends Error {
  readonly provider: ExecutionProviderName;
  readonly code: ExecutionErrorCode;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(init: ExecutionErrorInit) {
    super(init.message);
    this.name = 'ExecutionError';
    this.provider = init.provider;
    this.code = init.code;
    if (init.status !== undefined) this.status = init.status;
    if (init.cause !== undefined) this.cause = init.cause;
  }
}
