import { ExecutionError } from './errors';
import { getExecutionProvider } from './provider-factory';
import type { WorkflowExecutionResult } from './types';
import type { AriesWorkflowKey } from './workflow-catalog';

export type AriesRouteExecutionResult = WorkflowExecutionResult;

function mapExecutionErrorStatus(error: ExecutionError): number {
  switch (error.code) {
    case 'unauthorized':
      return 401;
    case 'not_configured':
    case 'unreachable':
      return 503;
    case 'request_invalid':
      return 400;
    case 'tool_unavailable':
      return 500;
    default:
      return error.status ?? 500;
  }
}

export async function runAriesWorkflow(
  key: AriesWorkflowKey,
  input: Record<string, unknown>,
): Promise<AriesRouteExecutionResult> {
  const provider = getExecutionProvider();
  return provider.runWorkflow(key, input);
}

export function mapAriesExecutionError(
  error: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof ExecutionError)) {
    return null;
  }
  return {
    status: mapExecutionErrorStatus(error),
    body: {
      status: 'error',
      error: error.message,
      reason: error.code,
      message: error.message,
    },
  };
}

/**
 * Best-effort cancel of an in-flight workflow run.
 *
 * Hermes run cancellation is not surfaced through the route execution port —
 * callers (e.g. the marketing job soft-delete path) invoke this best-effort and
 * tolerate a no-op. Retained as a stable seam should a Hermes cancel endpoint
 * be wired in later.
 */
export async function cancelAriesWorkflow(
  _input: { correlationId: string },
): Promise<{ cancelled: boolean; reason?: string }> {
  return { cancelled: false, reason: 'cancel_not_supported' };
}
