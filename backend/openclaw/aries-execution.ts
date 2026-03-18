import { OpenClawGatewayError, runOpenClawLobsterWorkflow, type LobsterEnvelope } from './gateway-client';
import { getAriesOpenClawWorkflow, type AriesOpenClawWorkflowKey } from './workflow-catalog';

export type ParityStubPayload = {
  status: 'not_implemented';
  code: 'workflow_missing_for_route';
  route: string;
  message: string;
  [key: string]: unknown;
};

export type AriesWorkflowExecutionResult =
  | { kind: 'ok'; envelope: LobsterEnvelope; primaryOutput: Record<string, unknown> | null }
  | { kind: 'not_implemented'; payload: ParityStubPayload }
  | { kind: 'gateway_error'; error: OpenClawGatewayError };

function primaryOutputRecord(envelope: LobsterEnvelope): Record<string, unknown> | null {
  if (!Array.isArray(envelope.output) || envelope.output.length === 0) return null;
  const first = envelope.output[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  return first as Record<string, unknown>;
}

function asParityStubPayload(record: Record<string, unknown> | null): ParityStubPayload | null {
  if (!record) return null;
  if (record.status !== 'not_implemented' || record.code !== 'workflow_missing_for_route') return null;
  if (typeof record.route !== 'string' || typeof record.message !== 'string') return null;
  return record as unknown as ParityStubPayload;
}

export async function runAriesOpenClawWorkflow(
  key: AriesOpenClawWorkflowKey,
  args: Record<string, unknown>,
): Promise<AriesWorkflowExecutionResult> {
  const workflow = getAriesOpenClawWorkflow(key);
  try {
    const envelope = await runOpenClawLobsterWorkflow({
      pipeline: workflow.pipeline,
      cwd: workflow.cwd,
      argsJson: JSON.stringify(args),
    });
    const primaryOutput = primaryOutputRecord(envelope);
    const parityStub = asParityStubPayload(primaryOutput);
    if (parityStub) {
      return { kind: 'not_implemented', payload: parityStub };
    }
    return { kind: 'ok', envelope, primaryOutput };
  } catch (error) {
    if (error instanceof OpenClawGatewayError) {
      return { kind: 'gateway_error', error };
    }
    throw error;
  }
}

export function mapOpenClawGatewayError(error: OpenClawGatewayError): { status: number; body: Record<string, unknown> } {
  switch (error.code) {
    case 'openclaw_gateway_not_configured':
      return { status: 503, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_unauthorized':
      return { status: 401, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_tool_unavailable':
      return { status: 500, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_request_invalid':
      return { status: 400, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_unreachable':
      return { status: 503, body: { status: 'error', reason: error.code, message: error.message } };
    default:
      return { status: error.status || 500, body: { status: 'error', reason: error.code, message: error.message } };
  }
}
