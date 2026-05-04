import type { LobsterEnvelope } from '../../openclaw/gateway-client';
import {
  createExecutionRunRecord,
  markExecutionRunFailed,
  markExecutionRunSubmitted,
} from '../../execution/run-store';
import type {
  MarketingExecutionResult,
  MarketingExecutionPort,
  MarketingPipelineResumeInput,
  MarketingPipelineRunInput,
} from '../execution-port';
import type { MarketingStage } from '../runtime-state';

type HermesMarketingEnv = Partial<Record<string, string | undefined>>;
type HermesMarketingFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type HermesMarketingSleep = (ms: number) => Promise<void>;

const MARKETING_WORKFLOW_KEY = 'marketing_pipeline';

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 50;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);

function readEnvValue(env: HermesMarketingEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readEnvInt(env: HermesMarketingEnv, key: string, fallback: number): number {
  const raw = readEnvValue(env, key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function tryParseJson(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function providerErrorEnvelope(code: string, message: string, detail?: Record<string, unknown>): LobsterEnvelope {
  return {
    ok: false,
    status: 'gateway_error',
    provider: 'hermes',
    code,
    message,
    detail,
  };
}

function missingConfigResult(keys: string): MarketingExecutionResult {
  return {
    kind: 'completed',
    provider: 'hermes',
    envelope: providerErrorEnvelope(
      'hermes_gateway_not_configured',
      `${keys} required when ARIES_MARKETING_EXECUTION_PROVIDER=hermes. Set HERMES_GATEWAY_URL and HERMES_API_SERVER_KEY, or set ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw to keep the legacy runtime.`,
    ),
  };
}

function gatewayErrorResult(code: string, message: string, detail?: Record<string, unknown>): MarketingExecutionResult {
  return {
    kind: 'completed',
    provider: 'hermes',
    envelope: providerErrorEnvelope(code, message, detail),
  };
}

function markSubmissionFailed(ariesRunId: string, code: string, message: string): void {
  markExecutionRunFailed(ariesRunId, {
    code,
    message,
    retryable: code === 'hermes_gateway_unreachable' || code === 'hermes_gateway_request_failed',
  });
}

/**
 * Marketing execution port backed by Hermes callbacks.
 *
 * Hermes is async: this adapter submits a run/resume request, persists the
 * Aries correlation id, and returns immediately. The callback route advances
 * marketing state when Hermes posts results back to Aries.
 */
export class HermesMarketingPort implements MarketingExecutionPort {
  readonly name = 'hermes' as const;

  constructor(
    private readonly env: HermesMarketingEnv = process.env,
    private readonly fetchImpl: HermesMarketingFetch = globalThis.fetch,
    private readonly sleep: HermesMarketingSleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async runPipeline(input: MarketingPipelineRunInput): Promise<MarketingExecutionResult> {
    return this.invoke('run', {
      jobId: input.jobId,
      tenantId: input.doc.tenant_id,
      argsJson: input.argsJson,
      stage: 'research',
    });
  }

  async resumePipeline(input: MarketingPipelineResumeInput): Promise<MarketingExecutionResult> {
    return this.invoke('resume', {
      jobId: input.jobId ?? undefined,
      tenantId: input.tenantId ?? undefined,
      approvalId: input.approvalId ?? undefined,
      stage: input.stage ?? undefined,
      workflowStepId: input.workflowStepId ?? undefined,
      resumeToken: input.resumeToken,
      approve: input.approve,
    });
  }

  private configurationError(): MarketingExecutionResult | null {
    const missing = ['HERMES_GATEWAY_URL', 'HERMES_API_SERVER_KEY']
      .filter((key) => !readEnvValue(this.env, key));
    return missing.length > 0 ? missingConfigResult(missing.join(', ')) : null;
  }

  private gatewayUrl(): string {
    return readEnvValue(this.env, 'HERMES_GATEWAY_URL').replace(/\/+$/, '');
  }

  private authHeader(): string {
    return `Bearer ${readEnvValue(this.env, 'HERMES_API_SERVER_KEY')}`;
  }

  private sessionKey(): string {
    return readEnvValue(this.env, 'HERMES_SESSION_KEY') || 'marketing';
  }

  private async invoke(
    action: 'run' | 'resume',
    input: {
      jobId?: string;
      tenantId?: string;
      argsJson?: string;
      stage?: MarketingStage;
      approvalId?: string;
      workflowStepId?: string;
      resumeToken?: string;
      approve?: boolean;
    },
  ): Promise<MarketingExecutionResult> {
    const configError = this.configurationError();
    if (configError) {
      return configError;
    }

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: MARKETING_WORKFLOW_KEY,
      action,
      tenantId: input.tenantId,
      marketingJobId: input.jobId,
      approvalId: input.approvalId,
      stage: input.stage ?? null,
      workflowStepId: input.workflowStepId,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl()}/v1/runs`, {
        method: 'POST',
        headers: {
          authorization: this.authHeader(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: this.prompt(action, run.aries_run_id, input),
          instructions: this.instructions(),
          session_id: this.sessionKey(),
        }),
      });
    } catch (error) {
      const message = 'Hermes gateway is unreachable.';
      markSubmissionFailed(run.aries_run_id, 'hermes_gateway_unreachable', message);
      return gatewayErrorResult('hermes_gateway_unreachable', message, {
        aries_run_id: run.aries_run_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!response.ok) {
      const message = `Hermes gateway returned HTTP ${response.status} on /v1/runs.`;
      markSubmissionFailed(run.aries_run_id, 'hermes_gateway_request_failed', message);
      return gatewayErrorResult(
        'hermes_gateway_request_failed',
        message,
        { status: response.status, aries_run_id: run.aries_run_id },
      );
    }

    const parsed = await this.parseJsonBody(response);
    const hermesRunId = typeof parsed?.run_id === 'string' ? parsed.run_id : '';
    if (!hermesRunId) {
      const message = 'Hermes /v1/runs response is missing run_id.';
      markSubmissionFailed(run.aries_run_id, 'hermes_gateway_response_invalid', message);
      return gatewayErrorResult('hermes_gateway_response_invalid', message, {
        aries_run_id: run.aries_run_id,
      });
    }

    markExecutionRunSubmitted(run.aries_run_id, { externalRunId: hermesRunId });
    return this.pollRunUntilTerminal(hermesRunId);
  }

  private async pollRunUntilTerminal(runId: string): Promise<MarketingExecutionResult> {
    const timeoutMs = readEnvInt(this.env, 'HERMES_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);
    const intervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      readEnvInt(this.env, 'HERMES_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    );
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      let pollResponse: Response;
      try {
        pollResponse = await this.fetchImpl(
          `${this.gatewayUrl()}/v1/runs/${encodeURIComponent(runId)}`,
          { method: 'GET', headers: { authorization: this.authHeader() } },
        );
      } catch (error) {
        return gatewayErrorResult('hermes_gateway_unreachable', 'Hermes gateway is unreachable while polling run status.', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!pollResponse.ok) {
        return gatewayErrorResult(
          'hermes_gateway_request_failed',
          `Hermes gateway returned HTTP ${pollResponse.status} polling run ${runId}.`,
          { status: pollResponse.status },
        );
      }
      const record = await this.parseJsonBody(pollResponse);
      const status = typeof record?.status === 'string' ? record.status : '';
      if (TERMINAL_STATUSES.has(status)) {
        return this.resultFromTerminalRun(runId, record ?? {});
      }
      await this.sleep(intervalMs);
    }

    return gatewayErrorResult(
      'hermes_gateway_timeout',
      `Hermes run ${runId} did not reach a terminal status within ${timeoutMs}ms.`,
    );
  }

  private resultFromTerminalRun(runId: string, record: Record<string, unknown>): MarketingExecutionResult {
    const status = typeof record.status === 'string' ? record.status : '';
    if (status === 'failed') {
      const message = typeof record.error === 'string' && record.error
        ? record.error
        : `Hermes run ${runId} failed without an error message.`;
      return gatewayErrorResult('hermes_run_failed', message, { run_id: runId });
    }
    if (status === 'cancelled' || status === 'stopped') {
      return gatewayErrorResult('hermes_run_cancelled', `Hermes run ${runId} ended with status ${status}.`, { run_id: runId });
    }

    const outputText = typeof record.output === 'string' ? record.output : '';
    const parsed = tryParseJson(outputText);
    const envelope: LobsterEnvelope = (
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as LobsterEnvelope
        : { ok: true, status: 'completed', provider: 'hermes', run_id: runId, output_text: outputText }
    );
    if (typeof envelope.ok !== 'boolean') envelope.ok = true;
    if (typeof envelope.status !== 'string') envelope.status = 'completed';
    return { kind: 'completed', provider: 'hermes', envelope };
  }

  private async parseJsonBody(response: Response): Promise<Record<string, unknown> | null> {
    try {
      const value = await response.json();
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private prompt(
    action: 'run' | 'resume',
    ariesRunId: string,
    input: {
      jobId?: string;
      argsJson?: string;
      approvalId?: string;
      workflowStepId?: string;
      resumeToken?: string;
      approve?: boolean;
    },
  ): string {
    if (action === 'run') {
      return [
        'Workflow: marketing_pipeline',
        'Action: run',
        `Aries run ID: ${ariesRunId}`,
        `Job ID: ${input.jobId ?? ''}`,
        `Args (JSON): ${input.argsJson ?? '{}'}`,
      ].join('\n');
    }

    return [
      'Workflow: marketing_pipeline',
      'Action: resume',
      `Aries run ID: ${ariesRunId}`,
      `Job ID: ${input.jobId ?? ''}`,
      `Approval ID: ${input.approvalId ?? ''}`,
      `Workflow step ID: ${input.workflowStepId ?? ''}`,
      `Resume token: ${input.resumeToken ?? ''}`,
      `Approve: ${input.approve === true}`,
    ].join('\n');
  }

  private instructions(): string {
    return [
      'You are the Aries marketing pipeline execution agent.',
      'Do not rely on Lobster runtime files.',
      'Reply with a single strict JSON object only — no prose, no markdown fences.',
      'Required schema: {"ok":true,"status":"completed","output":[{...}]}.',
      'If approval is required, set status to "requires_approval" and include a "requiresApproval" field with resumeToken, stage, and prompt.',
    ].join(' ');
  }
}
