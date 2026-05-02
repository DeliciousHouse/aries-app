import {
  runAriesOpenClawWorkflow,
  type ParityStubPayload as LegacyParityStubPayload,
} from '../openclaw/aries-execution';
import {
  OpenClawGatewayError,
  type LobsterEnvelope,
} from '../openclaw/gateway-client';
import {
  LegacyOpenClawExecutionAdapter,
  mapLegacyOpenClawGatewayError,
  type LegacyOpenClawCancelInput,
} from './providers/legacy-openclaw';
import { ExecutionError } from './errors';
import type { AriesWorkflowKey } from './workflow-catalog';

export type AriesRouteExecutionResult =
  | { kind: 'ok'; envelope: LobsterEnvelope; primaryOutput: Record<string, unknown> | null }
  | { kind: 'not_implemented'; payload: LegacyParityStubPayload }
  | { kind: 'gateway_error'; error: ExecutionError };

const legacyAdapter = new LegacyOpenClawExecutionAdapter();

function mapExecutionErrorStatus(error: ExecutionError): number {
  switch (error.code) {
    case 'unauthorized':
      return 401;
    case 'not_configured':
    case 'unreachable':
      return 503;
    case 'request_invalid':
      return 400;
    default:
      return error.status ?? 500;
  }
}

function executionErrorReason(error: ExecutionError): string {
  const cause = error.cause;
  if (cause instanceof OpenClawGatewayError) {
    return cause.code;
  }
  return error.code;
}

export async function runAriesWorkflow(
  key: AriesWorkflowKey,
  input: Record<string, unknown>,
): Promise<AriesRouteExecutionResult> {
  const executed = await runAriesOpenClawWorkflow(key, input);
  if (executed.kind === 'gateway_error') {
    return {
      kind: 'gateway_error',
      error: mapLegacyOpenClawGatewayError(executed.error),
    };
  }
  return executed;
}

export function mapAriesExecutionError(
  error: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (error instanceof OpenClawGatewayError) {
    return mapAriesExecutionError(mapLegacyOpenClawGatewayError(error));
  }
  if (!(error instanceof ExecutionError)) {
    return null;
  }
  return {
    status: mapExecutionErrorStatus(error),
    body: {
      error: error.message,
      reason: executionErrorReason(error),
    },
  };
}

export async function cancelAriesWorkflow(input: LegacyOpenClawCancelInput): Promise<{ cancelled: boolean; reason?: string }> {
  return legacyAdapter.cancel(input);
}
