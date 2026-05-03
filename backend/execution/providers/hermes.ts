import { ExecutionError } from '../errors';
import type { WorkflowEnvelope, WorkflowExecutionResult } from '../types';

type HermesExecutionEnv = Partial<Record<string, string | undefined>>;
type HermesFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const HERMES_RUN_TOOL = 'aries.workflow.run';
const HERMES_SUPPORTED_RUN_WORKFLOWS = new Set(['demo_start']);

type HermesRequestBase = {
  provider: 'hermes';
  sessionKey?: string;
  cwd?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
};

export type HermesRunRequestEnvelope = HermesRequestBase & {
  action: 'run';
  workflowId: string;
  argsJson: string;
};

export type HermesResumeRequestEnvelope = HermesRequestBase & {
  action: 'resume';
  workflowId: string;
  argsJson: string;
  approvalResumeToken: string;
  approve: boolean;
};

export type HermesCancelRequestEnvelope = HermesRequestBase & {
  action: 'cancel';
  cancelCorrelationId: string;
};

export type HermesRequestEnvelope =
  | HermesRunRequestEnvelope
  | HermesResumeRequestEnvelope
  | HermesCancelRequestEnvelope;

export type HermesRequestEnvelopeInput =
  | {
      action: 'run';
      workflowId: string;
      args: Record<string, unknown>;
      sessionKey?: string;
      cwd?: string;
      timeoutMs?: number;
      maxStdoutBytes?: number;
    }
  | {
      action: 'resume';
      workflowId: string;
      args: Record<string, unknown>;
      approvalResumeToken: string;
      approve: boolean;
      sessionKey?: string;
      cwd?: string;
      timeoutMs?: number;
      maxStdoutBytes?: number;
    }
  | {
      action: 'cancel';
      cancelCorrelationId: string;
      sessionKey?: string;
      cwd?: string;
      timeoutMs?: number;
      maxStdoutBytes?: number;
    };

function readEnvValue(env: HermesExecutionEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function addOptionalRequestFields<T extends HermesRequestEnvelope>(
  envelope: T,
  input: HermesRequestEnvelopeInput,
): T {
  if (input.sessionKey) envelope.sessionKey = input.sessionKey;
  if (input.cwd) envelope.cwd = input.cwd;
  if (input.timeoutMs !== undefined) envelope.timeoutMs = input.timeoutMs;
  if (input.maxStdoutBytes !== undefined) envelope.maxStdoutBytes = input.maxStdoutBytes;
  return envelope;
}

/**
 * Hermes execution request contract.
 *
 * Real invocation will send this provider-owned envelope to the Hermes gateway:
 * workflow id, JSON args, optional workspace/cwd, timeout and output caps,
 * approval resume token for paused approvals, and cancel correlation id for
 * cancellation. Phase 6 only pins the contract and returns honest unsupported
 * results; it must not silently fall back to OpenClaw.
 */
export function buildHermesRequestEnvelope(
  input: HermesRequestEnvelopeInput,
): HermesRequestEnvelope {
  switch (input.action) {
    case 'run':
      return addOptionalRequestFields(
        {
          provider: 'hermes',
          action: 'run',
          workflowId: input.workflowId,
          argsJson: JSON.stringify(input.args),
        },
        input,
      );
    case 'resume':
      return addOptionalRequestFields(
        {
          provider: 'hermes',
          action: 'resume',
          workflowId: input.workflowId,
          argsJson: JSON.stringify(input.args),
          approvalResumeToken: input.approvalResumeToken,
          approve: input.approve,
        },
        input,
      );
    case 'cancel':
      return addOptionalRequestFields(
        {
          provider: 'hermes',
          action: 'cancel',
          cancelCorrelationId: input.cancelCorrelationId,
        },
        input,
      );
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

function missingHermesConfigError(keys: 'HERMES_GATEWAY_URL' | 'HERMES_GATEWAY_TOKEN' | 'HERMES_GATEWAY_URL and HERMES_GATEWAY_TOKEN'): ExecutionError {
  return new ExecutionError({
    provider: 'hermes',
    code: 'not_configured',
    status: 503,
    message: `${keys} required when ARIES_EXECUTION_PROVIDER=hermes. Set the Hermes gateway URL and token, or set ARIES_EXECUTION_PROVIDER=legacy-openclaw to keep the current runtime.`,
  });
}

function notImplementedResult(route: string): WorkflowExecutionResult {
  return {
    kind: 'not_implemented',
    payload: {
      status: 'not_implemented',
      code: 'workflow_missing_for_route',
      route,
      message:
        'Hermes execution adapter is selected and configured, but real Hermes workflow invocation is not implemented in this phase.',
      provider: 'hermes',
    },
  };
}

function primaryOutputRecord(envelope: WorkflowEnvelope): Record<string, unknown> | null {
  const output = envelope.output;
  if (!Array.isArray(output) || output.length === 0) {
    return null;
  }

  const first = output[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return null;
  }

  return first as Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorCodeForStatus(status: number): ExecutionError['code'] {
  if (status === 401 || status === 403) {
    return 'unauthorized';
  }
  if (status === 404) {
    return 'tool_unavailable';
  }
  if (status >= 500) {
    return 'server_error';
  }
  return 'request_invalid';
}

function gatewayErrorResult(error: ExecutionError): WorkflowExecutionResult {
  return {
    kind: 'gateway_error',
    error,
  };
}

export class HermesExecutionAdapter {
  readonly name = 'hermes' as const;

  constructor(
    private readonly env: HermesExecutionEnv = process.env,
    private readonly fetchImpl: HermesFetch = globalThis.fetch,
  ) {}

  async runWorkflow(
    key: string,
    input: Record<string, unknown>,
  ): Promise<WorkflowExecutionResult> {
    const configError = this.configurationError();
    if (configError) {
      return gatewayErrorResult(configError);
    }
    if (!HERMES_SUPPORTED_RUN_WORKFLOWS.has(key)) {
      return notImplementedResult(key);
    }

    const envelope = buildHermesRequestEnvelope({
      action: 'run',
      workflowId: key,
      args: input,
      sessionKey: this.sessionKey(),
    }) as HermesRunRequestEnvelope;

    return this.invokeRunTool(envelope);
  }

  private configurationError(): ExecutionError | null {
    const missingGatewayUrl = !readEnvValue(this.env, 'HERMES_GATEWAY_URL');
    const missingGatewayToken = !readEnvValue(this.env, 'HERMES_GATEWAY_TOKEN');

    if (missingGatewayUrl && missingGatewayToken) {
      return missingHermesConfigError('HERMES_GATEWAY_URL and HERMES_GATEWAY_TOKEN');
    }
    if (missingGatewayUrl) {
      return missingHermesConfigError('HERMES_GATEWAY_URL');
    }
    if (missingGatewayToken) {
      return missingHermesConfigError('HERMES_GATEWAY_TOKEN');
    }
    return null;
  }

  private sessionKey(): string {
    return readEnvValue(this.env, 'HERMES_SESSION_KEY') || 'main';
  }

  private gatewayUrl(): string {
    return readEnvValue(this.env, 'HERMES_GATEWAY_URL').replace(/\/+$/, '');
  }

  private async invokeRunTool(envelope: HermesRunRequestEnvelope): Promise<WorkflowExecutionResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl()}/tools/invoke`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${readEnvValue(this.env, 'HERMES_GATEWAY_TOKEN')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tool: HERMES_RUN_TOOL,
          sessionKey: this.sessionKey(),
          args: envelope,
        }),
      });
    } catch (error) {
      return gatewayErrorResult(new ExecutionError({
        provider: 'hermes',
        code: 'unreachable',
        status: 503,
        message: 'Hermes gateway is unreachable.',
        cause: error,
      }));
    }

    if (!response.ok) {
      return gatewayErrorResult(new ExecutionError({
        provider: 'hermes',
        code: errorCodeForStatus(response.status),
        status: response.status,
        message: `Hermes gateway returned HTTP ${response.status}.`,
      }));
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      return gatewayErrorResult(new ExecutionError({
        provider: 'hermes',
        code: 'response_invalid',
        status: response.status,
        message: 'Hermes gateway returned invalid JSON.',
        cause: error,
      }));
    }

    const responseRecord = recordValue(parsed);
    if (!responseRecord) {
      return gatewayErrorResult(new ExecutionError({
        provider: 'hermes',
        code: 'response_invalid',
        status: response.status,
        message: 'Hermes gateway returned a non-object response.',
      }));
    }

    if (responseRecord.ok === false) {
      const errorRecord = recordValue(responseRecord.error);
      const errorMessage =
        (typeof responseRecord.error === 'string' && responseRecord.error) ||
        (errorRecord && typeof errorRecord.message === 'string' && errorRecord.message) ||
        'Hermes gateway reported a tool-level failure.';
      return gatewayErrorResult(new ExecutionError({
        provider: 'hermes',
        code: 'response_invalid',
        status: response.status,
        message: errorMessage,
      }));
    }

    const workflowEnvelope = (recordValue(responseRecord.envelope) ?? responseRecord) as WorkflowEnvelope;
    return {
      kind: 'ok',
      envelope: workflowEnvelope,
      primaryOutput: recordValue(responseRecord.primaryOutput) ?? primaryOutputRecord(workflowEnvelope),
    };
  }
}
