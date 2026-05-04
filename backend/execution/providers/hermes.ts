import { ExecutionError } from '../errors';
import type { WorkflowEnvelope, WorkflowExecutionResult } from '../types';

type HermesExecutionEnv = Partial<Record<string, string | undefined>>;
type HermesFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type HermesSleep = (ms: number) => Promise<void>;

const HERMES_SUPPORTED_RUN_WORKFLOWS = new Set(['demo_start']);

const DEFAULT_RUN_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 50;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);

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

function readEnvInt(env: HermesExecutionEnv, key: string, fallback: number): number {
  const raw = readEnvValue(env, key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
 * Internal request envelope shape. Retained as a stable serialization of the
 * Aries-side execution intent. `submitRun()` converts this to a human-readable
 * prompt via `promptForWorkflow()` and per-workflow instructions via
 * `instructionsForWorkflow()` before sending to the Hermes /v1/runs endpoint.
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

function missingHermesConfigError(keys: 'HERMES_GATEWAY_URL' | 'HERMES_API_SERVER_KEY' | 'HERMES_GATEWAY_URL and HERMES_API_SERVER_KEY'): ExecutionError {
  return new ExecutionError({
    provider: 'hermes',
    code: 'not_configured',
    status: 503,
    message: `${keys} required when ARIES_EXECUTION_PROVIDER=hermes. Set HERMES_GATEWAY_URL and HERMES_API_SERVER_KEY (the value of API_SERVER_KEY from the Hermes .env), or set ARIES_EXECUTION_PROVIDER=legacy-openclaw to keep the current runtime.`,
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
        'Hermes execution adapter does not yet wire this workflow. Only demo_start is supported.',
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

function instructionsForWorkflow(workflowId: string): string {
  if (workflowId === 'demo_start') {
    return [
      'You are the Aries demo provisioning agent.',
      'Reply with a single strict JSON object only — no prose, no markdown fences.',
      'Required schema: {"status":"ok","output":[{...}],"message":"..."}.',
      'The first output entry should describe the provisioned demo (e.g. provisioned: true, lead_id, next_step).',
    ].join(' ');
  }
  return 'Reply with a single strict JSON object only — no prose, no markdown fences.';
}

function promptForWorkflow(envelope: HermesRunRequestEnvelope): string {
  return [
    `Workflow: ${envelope.workflowId}`,
    `Args (JSON): ${envelope.argsJson}`,
    'Produce the JSON envelope for this workflow now.',
  ].join('\n');
}

function tryParseJson(text: string): unknown {
  if (!text) return null;
  // The agent may wrap JSON in fences despite instructions; try a fenced extract first.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export class HermesExecutionAdapter {
  readonly name = 'hermes' as const;

  constructor(
    private readonly env: HermesExecutionEnv = process.env,
    private readonly fetchImpl: HermesFetch = globalThis.fetch,
    private readonly sleep: HermesSleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
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

    return this.invokeRun(envelope);
  }

  private configurationError(): ExecutionError | null {
    const missingGatewayUrl = !readEnvValue(this.env, 'HERMES_GATEWAY_URL');
    const missingApiServerKey = !readEnvValue(this.env, 'HERMES_API_SERVER_KEY');

    if (missingGatewayUrl && missingApiServerKey) {
      return missingHermesConfigError('HERMES_GATEWAY_URL and HERMES_API_SERVER_KEY');
    }
    if (missingGatewayUrl) {
      return missingHermesConfigError('HERMES_GATEWAY_URL');
    }
    if (missingApiServerKey) {
      return missingHermesConfigError('HERMES_API_SERVER_KEY');
    }
    return null;
  }

  private sessionKey(): string {
    return readEnvValue(this.env, 'HERMES_SESSION_KEY') || 'main';
  }

  private gatewayUrl(): string {
    return readEnvValue(this.env, 'HERMES_GATEWAY_URL').replace(/\/+$/, '');
  }

  private authHeader(): string {
    return `Bearer ${readEnvValue(this.env, 'HERMES_API_SERVER_KEY')}`;
  }

  private async invokeRun(envelope: HermesRunRequestEnvelope): Promise<WorkflowExecutionResult> {
    const submission = await this.submitRun(envelope);
    if (submission.kind !== 'submitted') {
      return submission.result;
    }
    return this.pollRunUntilTerminal(submission.runId);
  }

  private async submitRun(
    envelope: HermesRunRequestEnvelope,
  ): Promise<{ kind: 'submitted'; runId: string } | { kind: 'error'; result: WorkflowExecutionResult }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl()}/v1/runs`, {
        method: 'POST',
        headers: {
          authorization: this.authHeader(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: promptForWorkflow(envelope),
          instructions: instructionsForWorkflow(envelope.workflowId),
          session_id: this.sessionKey(),
        }),
      });
    } catch (error) {
      return {
        kind: 'error',
        result: gatewayErrorResult(new ExecutionError({
          provider: 'hermes',
          code: 'unreachable',
          status: 503,
          message: 'Hermes gateway is unreachable.',
          cause: error,
        })),
      };
    }

    if (!response.ok) {
      return {
        kind: 'error',
        result: gatewayErrorResult(new ExecutionError({
          provider: 'hermes',
          code: errorCodeForStatus(response.status),
          status: response.status,
          message: `Hermes gateway returned HTTP ${response.status} on /v1/runs.`,
        })),
      };
    }

    const parsed = await this.parseJsonBody(response);
    if (parsed.kind === 'error') {
      return { kind: 'error', result: parsed.result };
    }
    const record = recordValue(parsed.value);
    const runId = record && typeof record.run_id === 'string' ? record.run_id : '';
    if (!runId) {
      return {
        kind: 'error',
        result: gatewayErrorResult(new ExecutionError({
          provider: 'hermes',
          code: 'response_invalid',
          status: response.status,
          message: 'Hermes /v1/runs response is missing run_id.',
        })),
      };
    }
    return { kind: 'submitted', runId };
  }

  private async pollRunUntilTerminal(runId: string): Promise<WorkflowExecutionResult> {
    const timeoutMs = readEnvInt(this.env, 'HERMES_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);
    const intervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      readEnvInt(this.env, 'HERMES_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    );
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.gatewayUrl()}/v1/runs/${encodeURIComponent(runId)}`, {
          method: 'GET',
          headers: { authorization: this.authHeader() },
        });
      } catch (error) {
        return gatewayErrorResult(new ExecutionError({
          provider: 'hermes',
          code: 'unreachable',
          status: 503,
          message: 'Hermes gateway is unreachable while polling run status.',
          cause: error,
        }));
      }
      if (!response.ok) {
        return gatewayErrorResult(new ExecutionError({
          provider: 'hermes',
          code: errorCodeForStatus(response.status),
          status: response.status,
          message: `Hermes gateway returned HTTP ${response.status} polling run ${runId}.`,
        }));
      }
      const parsed = await this.parseJsonBody(response);
      if (parsed.kind === 'error') {
        return parsed.result;
      }
      const record = recordValue(parsed.value);
      const status = record && typeof record.status === 'string' ? record.status : '';
      if (TERMINAL_STATUSES.has(status)) {
        return this.resultFromTerminalRun(runId, record ?? {}, response.status);
      }
      await this.sleep(intervalMs);
    }

    return gatewayErrorResult(new ExecutionError({
      provider: 'hermes',
      code: 'server_error',
      status: 504,
      message: `Hermes run ${runId} did not reach a terminal status within ${timeoutMs}ms.`,
    }));
  }

  private resultFromTerminalRun(
    runId: string,
    record: Record<string, unknown>,
    httpStatus: number,
  ): WorkflowExecutionResult {
    const status = typeof record.status === 'string' ? record.status : '';
    if (status === 'failed') {
      const errorText = typeof record.error === 'string' && record.error
        ? record.error
        : `Hermes run ${runId} failed without an error message.`;
      return gatewayErrorResult(new ExecutionError({
        provider: 'hermes',
        code: 'server_error',
        status: httpStatus,
        message: errorText,
      }));
    }
    if (status === 'cancelled' || status === 'stopped') {
      return gatewayErrorResult(new ExecutionError({
        provider: 'hermes',
        code: 'server_error',
        status: httpStatus,
        message: `Hermes run ${runId} ended with status ${status}.`,
      }));
    }

    // status === 'completed'
    const outputText = typeof record.output === 'string' ? record.output : '';
    const parsedOutput = tryParseJson(outputText);
    const envelopeRecord = recordValue(parsedOutput);
    const envelope: WorkflowEnvelope = envelopeRecord ?? {
      status: 'ok',
      provider: 'hermes',
      run_id: runId,
      output_text: outputText,
    };
    if (typeof envelope.status !== 'string') {
      envelope.status = 'ok';
    }
    if (envelope.run_id === undefined) {
      envelope.run_id = runId;
    }
    return {
      kind: 'ok',
      envelope,
      primaryOutput: primaryOutputRecord(envelope),
    };
  }

  private async parseJsonBody(
    response: Response,
  ): Promise<{ kind: 'value'; value: unknown } | { kind: 'error'; result: WorkflowExecutionResult }> {
    try {
      return { kind: 'value', value: await response.json() };
    } catch (error) {
      return {
        kind: 'error',
        result: gatewayErrorResult(new ExecutionError({
          provider: 'hermes',
          code: 'response_invalid',
          status: response.status,
          message: 'Hermes gateway returned invalid JSON.',
          cause: error,
        })),
      };
    }
  }
}
