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

const MARKETING_WORKFLOW_KEY = 'marketing_pipeline';

function readEnvValue(env: HermesMarketingEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
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
      `${keys} required when ARIES_MARKETING_EXECUTION_PROVIDER=hermes. Set HERMES_GATEWAY_URL, HERMES_API_SERVER_KEY, and APP_BASE_URL, or set ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw to keep the legacy runtime.`,
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
    const missing = ['HERMES_GATEWAY_URL', 'HERMES_API_SERVER_KEY', 'APP_BASE_URL']
      .filter((key) => !readEnvValue(this.env, key));
    return missing.length > 0 ? missingConfigResult(missing.join(', ')) : null;
  }

  private gatewayUrl(): string {
    return readEnvValue(this.env, 'HERMES_GATEWAY_URL').replace(/\/+$/, '');
  }

  private callbackUrl(): string {
    return `${readEnvValue(this.env, 'APP_BASE_URL').replace(/\/+$/, '')}/api/internal/hermes/runs`;
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
          callback_url: this.callbackUrl(),
          metadata: {
            aries_run_id: run.aries_run_id,
            workflow_key: MARKETING_WORKFLOW_KEY,
            domain: 'marketing',
            marketing_job_id: input.jobId ?? null,
            approval_id: input.approvalId ?? null,
            stage: input.stage ?? null,
            workflow_step_id: input.workflowStepId ?? null,
          },
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
    return {
      kind: 'submitted',
      provider: 'hermes',
      ariesRunId: run.aries_run_id,
      hermesRunId,
    };
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
      'Post progress and terminal results back to the supplied callback_url with event_id, aries_run_id, status, and output.',
    ].join(' ');
  }
}
