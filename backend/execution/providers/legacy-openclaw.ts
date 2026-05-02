import {
  OpenClawGatewayError,
  type LobsterEnvelope,
  type OpenClawCancelCallInput,
  type OpenClawResumeCallInput,
  type OpenClawWorkflowCallInput,
  cancelOpenClawLobsterWorkflow,
  resumeOpenClawLobsterWorkflow,
  runOpenClawLobsterWorkflow,
} from '../../openclaw/gateway-client';
import { ExecutionError, type ExecutionErrorCode } from '../errors';
import type { WorkflowExecutionResult } from '../types';

function primaryOutputRecord(envelope: LobsterEnvelope): Record<string, unknown> | null {
  if (!Array.isArray(envelope.output) || envelope.output.length === 0) {
    return null;
  }

  const first = envelope.output[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return null;
  }

  return first as Record<string, unknown>;
}

function mapLegacyOpenClawCode(
  code: OpenClawGatewayError['code'],
): ExecutionErrorCode {
  switch (code) {
    case 'openclaw_gateway_not_configured':
      return 'not_configured';
    case 'openclaw_gateway_unauthorized':
      return 'unauthorized';
    case 'openclaw_gateway_unreachable':
      return 'unreachable';
    case 'openclaw_gateway_tool_unavailable':
      return 'tool_unavailable';
    case 'openclaw_gateway_request_invalid':
      return 'request_invalid';
    case 'openclaw_gateway_response_invalid':
      return 'response_invalid';
    case 'openclaw_gateway_server_error':
      return 'server_error';
  }
}

export function mapLegacyOpenClawGatewayError(error: OpenClawGatewayError): ExecutionError {
  return new ExecutionError({
    provider: 'openclaw',
    code: mapLegacyOpenClawCode(error.code),
    message: error.message,
    status: error.status,
    cause: error,
  });
}

function asOkResult(envelope: LobsterEnvelope): WorkflowExecutionResult {
  return {
    kind: 'ok',
    envelope,
    primaryOutput: primaryOutputRecord(envelope),
  };
}

function asGatewayErrorResult(error: OpenClawGatewayError): WorkflowExecutionResult {
  return {
    kind: 'gateway_error',
    error: mapLegacyOpenClawGatewayError(error),
  };
}

export class LegacyOpenClawExecutionAdapter {
  readonly name = 'openclaw' as const;

  async run(input: OpenClawWorkflowCallInput): Promise<WorkflowExecutionResult> {
    try {
      return asOkResult(await runOpenClawLobsterWorkflow(input));
    } catch (error) {
      if (error instanceof OpenClawGatewayError) {
        return asGatewayErrorResult(error);
      }
      throw error;
    }
  }

  async resume(input: OpenClawResumeCallInput): Promise<WorkflowExecutionResult> {
    try {
      return asOkResult(await resumeOpenClawLobsterWorkflow(input));
    } catch (error) {
      if (error instanceof OpenClawGatewayError) {
        return asGatewayErrorResult(error);
      }
      throw error;
    }
  }

  async cancel(input: OpenClawCancelCallInput): Promise<{ cancelled: boolean; reason?: string }> {
    return cancelOpenClawLobsterWorkflow(input);
  }
}

export type {
  OpenClawCancelCallInput as LegacyOpenClawCancelInput,
  OpenClawResumeCallInput as LegacyOpenClawResumeInput,
  OpenClawWorkflowCallInput as LegacyOpenClawRunInput,
};
