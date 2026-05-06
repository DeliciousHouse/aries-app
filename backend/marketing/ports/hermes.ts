import { randomBytes } from 'node:crypto';

import pool from '@/lib/db';
import { hashCallbackToken } from '@/lib/internal-callback-auth';
import {
  createExecutionRunRecord,
  markExecutionRunFailed,
  markExecutionRunSubmitted,
} from '../../execution/run-store';
import { SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY } from '../../social-content/defaults';
import { approvalStepFromWorkflowStepId } from '../../social-content/runtime-state';
import {
  buildSocialContentWeeklyRequest,
  ensureFreshBrandKitForWeeklyRun,
} from '../../social-content/workflow-request';
import type {
  HermesWorkflowOutput,
  MarketingExecutionResult,
  MarketingExecutionPort,
  MarketingPipelineResumeInput,
  MarketingPipelineRunInput,
} from '../execution-port';
import type { MarketingJobRuntimeDocument, MarketingStage } from '../runtime-state';
import type { SocialContentApprovalStep } from '@/backend/social-content/types';

type HermesCallbackTokenClient = {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
};

type HermesMarketingEnv = Partial<Record<string, string | undefined>>;
type HermesMarketingFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type HermesMarketingSleep = (ms: number) => Promise<void>;
type HermesBrandKitRefresher = (input: {
  doc: MarketingJobRuntimeDocument;
  fetchImpl?: typeof fetch;
}) => Promise<{ refreshed: boolean }>;

const BRAND_CAMPAIGN_WORKFLOW_KEY = 'marketing_pipeline';

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 50;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);

function isWeeklySocialContentRequest(doc?: MarketingJobRuntimeDocument): boolean {
  const request = doc?.inputs?.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return false;
  }
  return (request as Record<string, unknown>).jobType === 'weekly_social_content';
}

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

function providerErrorOutput(
  code: string,
  message: string,
  detail?: Record<string, unknown>,
  workflowKey = BRAND_CAMPAIGN_WORKFLOW_KEY,
): HermesWorkflowOutput {
  return {
    ok: false,
    status: 'failed',
    workflowKey,
    error: {
      code,
      message,
      retryable: code === 'hermes_gateway_unreachable' || code === 'hermes_gateway_request_failed',
    },
    output: detail,
  };
}

function missingConfigResult(keys: string): MarketingExecutionResult {
  return {
    kind: 'completed',
    provider: 'hermes',
    output: providerErrorOutput(
      'hermes_gateway_not_configured',
      `${keys} required for Hermes social-content execution.`,
    ),
  };
}

function gatewayErrorResult(
  code: string,
  message: string,
  detail?: Record<string, unknown>,
  workflowKey = BRAND_CAMPAIGN_WORKFLOW_KEY,
): MarketingExecutionResult {
  return {
    kind: 'completed',
    provider: 'hermes',
    output: providerErrorOutput(code, message, detail, workflowKey),
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
 * Marketing execution port backed by Hermes submissions + callbacks.
 *
 * By default, run/resume requests submit to Hermes and return immediately
 * as `kind: 'submitted'`. Runtime progression is driven by authenticated
 * callbacks to `/api/internal/hermes/runs`.
 *
 * Legacy sync polling is retained only for diagnostics/tests behind:
 * `HERMES_SYNC_POLL_FOR_TESTS=1`.
 */
export class HermesMarketingPort implements MarketingExecutionPort {
  readonly name = 'hermes' as const;

  constructor(
    private readonly env: HermesMarketingEnv = process.env,
    private readonly fetchImpl: HermesMarketingFetch = globalThis.fetch,
    private readonly sleep: HermesMarketingSleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly brandKitRefresher: HermesBrandKitRefresher = ensureFreshBrandKitForWeeklyRun,
    private readonly callbackTokenClient: HermesCallbackTokenClient = pool,
  ) {}

  async runPipeline(input: MarketingPipelineRunInput): Promise<MarketingExecutionResult> {
    return this.invoke('run', {
      jobId: input.jobId,
      tenantId: input.doc.tenant_id,
      doc: input.doc,
      argsJson: input.argsJson,
      stage: 'research',
    });
  }

  private async refreshBrandKitOrFail(
    doc: MarketingJobRuntimeDocument,
  ): Promise<MarketingExecutionResult | null> {
    try {
      await this.brandKitRefresher({ doc });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.startsWith('needs_brand_kit') ? 'needs_brand_kit' : 'brand_kit_unavailable';
      return {
        kind: 'completed',
        provider: 'hermes',
        output: {
          ok: false,
          status: 'failed',
          workflowKey: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
          error: {
            code,
            message,
            retryable: true,
          },
        },
      };
    }
  }

  async resumePipeline(input: MarketingPipelineResumeInput): Promise<MarketingExecutionResult> {
    return this.invoke('resume', {
      jobId: input.jobId ?? undefined,
      tenantId: input.tenantId ?? undefined,
      approvalId: input.approvalId ?? undefined,
      stage: input.stage ?? undefined,
      workflowStepId: input.workflowStepId ?? undefined,
      approvalStep: input.approvalStep ?? undefined,
      workflowKey: input.workflowKey ?? undefined,
      resumeToken: input.resumeToken,
      approve: input.approve,
    });
  }

  private configurationError(): MarketingExecutionResult | null {
    const missing = ['HERMES_GATEWAY_URL', 'HERMES_API_SERVER_KEY', 'INTERNAL_API_SECRET', 'APP_BASE_URL']
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

  private callbackUrl(): string {
    const appBaseUrl = readEnvValue(this.env, 'APP_BASE_URL').replace(/\/+$/, '');
    return `${appBaseUrl}/api/internal/hermes/runs`;
  }

  private syncPollingEnabled(): boolean {
    return readEnvValue(this.env, 'HERMES_SYNC_POLL_FOR_TESTS') === '1';
  }

  private async invoke(
    action: 'run' | 'resume',
    input: {
      jobId?: string;
      tenantId?: string;
      doc?: MarketingJobRuntimeDocument;
      argsJson?: string;
      stage?: MarketingStage;
      approvalId?: string;
      workflowStepId?: string;
      approvalStep?: SocialContentApprovalStep;
      workflowKey?: string;
      resumeToken?: string;
      approve?: boolean;
    },
  ): Promise<MarketingExecutionResult> {
    const configError = this.configurationError();
    if (configError) {
      return configError;
    }
    if (action === 'run' && input.doc && isWeeklySocialContentRequest(input.doc)) {
      const brandKitFailure = await this.refreshBrandKitOrFail(input.doc);
      if (brandKitFailure) {
        return brandKitFailure;
      }
    }
    const workflowKey = this.workflowKeyFor(action, input);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey,
      action,
      tenantId: input.tenantId,
      marketingJobId: input.jobId,
      approvalId: input.approvalId,
      stage: input.stage ?? null,
      workflowStepId: input.workflowStepId,
    });

    const callbackToken = randomBytes(32).toString('hex');
    await this.persistCallbackTokenHash(run.aries_run_id, input.tenantId, callbackToken);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl()}/v1/runs`, {
        method: 'POST',
        headers: {
          authorization: this.authHeader(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(this.submissionPayload(action, run.aries_run_id, input, workflowKey, callbackToken)),
      });
    } catch (error) {
      const message = 'Hermes gateway is unreachable.';
      markSubmissionFailed(run.aries_run_id, 'hermes_gateway_unreachable', message);
      return gatewayErrorResult('hermes_gateway_unreachable', message, {
        aries_run_id: run.aries_run_id,
        error: error instanceof Error ? error.message : String(error),
      }, workflowKey);
    }

    if (!response.ok) {
      const message = `Hermes gateway returned HTTP ${response.status} on /v1/runs.`;
      markSubmissionFailed(run.aries_run_id, 'hermes_gateway_request_failed', message);
      return gatewayErrorResult(
        'hermes_gateway_request_failed',
        message,
        { status: response.status, aries_run_id: run.aries_run_id },
        workflowKey,
      );
    }

    const parsed = await this.parseJsonBody(response);
    const hermesRunId = typeof parsed?.run_id === 'string' ? parsed.run_id : '';
    if (!hermesRunId) {
      const message = 'Hermes /v1/runs response is missing run_id.';
      markSubmissionFailed(run.aries_run_id, 'hermes_gateway_response_invalid', message);
      return gatewayErrorResult('hermes_gateway_response_invalid', message, {
        aries_run_id: run.aries_run_id,
      }, workflowKey);
    }

    markExecutionRunSubmitted(run.aries_run_id, { externalRunId: hermesRunId });
    if (this.syncPollingEnabled()) {
      return this.pollRunUntilTerminal(hermesRunId, run.aries_run_id);
    }
    return {
      kind: 'submitted',
      provider: 'hermes',
      ariesRunId: run.aries_run_id,
      hermesRunId,
    };
  }

  private submissionPayload(
    action: 'run' | 'resume',
    ariesRunId: string,
    input: {
      jobId?: string;
      tenantId?: string;
      doc?: MarketingJobRuntimeDocument;
      argsJson?: string;
      stage?: MarketingStage;
      approvalId?: string;
      workflowStepId?: string;
      approvalStep?: SocialContentApprovalStep;
      workflowKey?: string;
      resumeToken?: string;
      approve?: boolean;
    },
    workflowKey: string,
    callbackToken: string,
  ): Record<string, unknown> {
    const callbackAuth = {
      type: 'internal_api_secret_bearer',
      secret_ref: 'INTERNAL_API_SECRET',
      callback_token: callbackToken,
    };

    if (action === 'resume' && workflowKey === SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY) {
      const approvalStep =
        input.approvalStep ??
        approvalStepFromWorkflowStepId(input.workflowStepId ?? '') ??
        null;
      return {
        workflow_key: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
        action: 'resume',
        aries_run_id: ariesRunId,
        approval_step: approvalStep,
        approval_id: input.approvalId ?? null,
        resume_token: input.resumeToken ?? '',
        approved: input.approve === true,
        job_id: input.jobId ?? null,
        tenant_id: input.tenantId ?? null,
        callback_url: this.callbackUrl(),
        callback_auth: callbackAuth,
        callback_context: {
          workflow_key: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
          aries_run_id: ariesRunId,
          job_id: input.jobId ?? null,
          tenant_id: input.tenantId ?? null,
          approval_id: input.approvalId ?? null,
          approval_step: approvalStep,
        },
      };
    }

    if (action === 'run' && input.doc && isWeeklySocialContentRequest(input.doc)) {
      const request = buildSocialContentWeeklyRequest({
        doc: input.doc,
        ariesRunId,
        callbackUrl: this.callbackUrl(),
      });
      return {
        ...request,
        session_id: this.sessionKey(),
        callback_auth: callbackAuth,
        callback_context: {
          workflow_key: request.workflow_key,
          workflow_version: request.workflow_version,
          aries_run_id: request.aries_run_id,
          job_id: request.job_id,
          tenant_id: request.tenant_id,
        },
      };
    }

    return {
      input: this.prompt(action, ariesRunId, input, workflowKey),
      instructions: this.instructions(workflowKey),
      session_id: this.sessionKey(),
      callback_url: this.callbackUrl(),
      callback_auth: callbackAuth,
      callback_context: {
        workflow_key: workflowKey,
        aries_run_id: ariesRunId,
        job_id: input.jobId ?? null,
        tenant_id: input.tenantId ?? null,
      },
    };
  }

  private async persistCallbackTokenHash(
    ariesRunId: string,
    tenantId: string | undefined,
    plaintextToken: string,
  ): Promise<void> {
    const tenantIdInt = Number.parseInt(tenantId ?? '', 10);
    if (!Number.isFinite(tenantIdInt) || tenantIdInt <= 0) {
      return;
    }
    const tokenHash = hashCallbackToken(plaintextToken);
    try {
      await this.callbackTokenClient.query(
        `INSERT INTO oauth_callback_tokens (token_hash, aries_run_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO NOTHING`,
        [tokenHash, ariesRunId, tenantIdInt],
      );
    } catch (error) {
      console.error('[hermes-port] failed to persist callback token hash', {
        aries_run_id: ariesRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private workflowKeyFor(
    action: 'run' | 'resume',
    input: { doc?: MarketingJobRuntimeDocument; workflowKey?: string },
  ): string {
    if (action === 'resume' && input.workflowKey && input.workflowKey.trim().length > 0) {
      return input.workflowKey.trim();
    }
    return action === 'run' && input.doc && isWeeklySocialContentRequest(input.doc)
      ? SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY
      : BRAND_CAMPAIGN_WORKFLOW_KEY;
  }

  private async pollRunUntilTerminal(runId: string, ariesRunId: string): Promise<MarketingExecutionResult> {
    const timeoutMs = readEnvInt(this.env, 'HERMES_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);
    const intervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      readEnvInt(this.env, 'HERMES_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    );
    const deadline = Date.now() + timeoutMs;

    const failRun = (code: string, message: string, detail?: Record<string, unknown>): MarketingExecutionResult => {
      markSubmissionFailed(ariesRunId, code, message);
      return gatewayErrorResult(code, message, detail);
    };

    while (Date.now() <= deadline) {
      let pollResponse: Response;
      try {
        pollResponse = await this.fetchImpl(
          `${this.gatewayUrl()}/v1/runs/${encodeURIComponent(runId)}`,
          { method: 'GET', headers: { authorization: this.authHeader() } },
        );
      } catch (error) {
        return failRun('hermes_gateway_unreachable', 'Hermes gateway is unreachable while polling run status.', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!pollResponse.ok) {
        return failRun(
          'hermes_gateway_request_failed',
          `Hermes gateway returned HTTP ${pollResponse.status} polling run ${runId}.`,
          { status: pollResponse.status },
        );
      }
      const record = await this.parseJsonBody(pollResponse);
      if (!record || typeof record.status !== 'string') {
        return failRun(
          'hermes_gateway_response_invalid',
          `Hermes poll response for run ${runId} is missing a status field.`,
        );
      }
      if (TERMINAL_STATUSES.has(record.status)) {
        return this.resultFromTerminalRun(runId, ariesRunId, record);
      }
      await this.sleep(intervalMs);
    }

    return failRun(
      'hermes_gateway_timeout',
      `Hermes run ${runId} did not reach a terminal status within ${timeoutMs}ms.`,
    );
  }

  private resultFromTerminalRun(
    runId: string,
    ariesRunId: string,
    record: Record<string, unknown>,
  ): MarketingExecutionResult {
    const status = typeof record.status === 'string' ? record.status : '';
    if (status === 'failed') {
      const message = typeof record.error === 'string' && record.error
        ? record.error
        : `Hermes run ${runId} failed without an error message.`;
      markSubmissionFailed(ariesRunId, 'hermes_run_failed', message);
      return gatewayErrorResult('hermes_run_failed', message, { run_id: runId });
    }
    if (status === 'cancelled' || status === 'stopped') {
      const message = `Hermes run ${runId} ended with status ${status}.`;
      markSubmissionFailed(ariesRunId, 'hermes_run_cancelled', message);
      return gatewayErrorResult('hermes_run_cancelled', message, { run_id: runId });
    }

    // status === 'completed'
    const output = this.workflowOutputFromRunRecord(runId, record);
    if (!output) {
      const message = `Hermes run ${runId} returned unparseable output.`;
      markSubmissionFailed(ariesRunId, 'hermes_output_invalid', message);
      return gatewayErrorResult('hermes_output_invalid', message, { run_id: runId });
    }
    return { kind: 'completed', provider: 'hermes', output };
  }
  private workflowOutputFromRunRecord(
    runId: string,
    record: Record<string, unknown>,
  ): HermesWorkflowOutput | null {
    const rawOutput = record.output;
    const parsedOutput = typeof rawOutput === 'string' ? tryParseJson(rawOutput) : rawOutput;
    if (parsedOutput == null) {
      return {
        ok: true,
        status: 'completed',
        workflowKey: BRAND_CAMPAIGN_WORKFLOW_KEY,
        runId,
      };
    }

    if (Array.isArray(parsedOutput)) {
      return {
        ok: true,
        status: 'completed',
        workflowKey: BRAND_CAMPAIGN_WORKFLOW_KEY,
        runId,
        output: parsedOutput.filter(
          (entry): entry is Record<string, unknown> =>
            !!entry && typeof entry === 'object' && !Array.isArray(entry),
        ),
      };
    }

    if (!parsedOutput || typeof parsedOutput !== 'object') {
      return null;
    }

    const parsedRecord = parsedOutput as Record<string, unknown>;
    const status = typeof parsedRecord.status === 'string'
      ? parsedRecord.status
      : 'completed';
    const normalizedStatus: HermesWorkflowOutput['status'] = (
      status === 'running'
      || status === 'requires_approval'
      || status === 'completed'
      || status === 'failed'
      || status === 'cancelled'
    )
      ? status
      : 'completed';

    const approval = (() => {
      const documentedApproval = parsedRecord.approval;
      if (documentedApproval && typeof documentedApproval === 'object' && !Array.isArray(documentedApproval)) {
        return documentedApproval as Record<string, unknown>;
      }
      const legacyApproval = parsedRecord.requiresApproval;
      return legacyApproval && typeof legacyApproval === 'object' && !Array.isArray(legacyApproval)
        ? (legacyApproval as Record<string, unknown>)
        : null;
    })();
    const approvalStage = typeof approval?.stage === 'string'
      ? approval.stage
      : typeof approval?.approval_stage === 'string'
        ? approval.approval_stage
        : typeof approval?.approvalStage === 'string'
          ? approval.approvalStage
          : undefined;
    const approvalStep = typeof approval?.approval_step === 'string'
      ? approval.approval_step
      : typeof approval?.approvalStep === 'string'
        ? approval.approvalStep
        : undefined;
    const workflowStepId = typeof approval?.workflowStepId === 'string'
      ? approval.workflowStepId
      : typeof approval?.workflow_step_id === 'string'
        ? approval.workflow_step_id
        : '';
    const prompt = typeof approval?.prompt === 'string' ? approval.prompt : '';
    const resumeToken = typeof approval?.resumeToken === 'string'
      ? approval.resumeToken
      : typeof approval?.resume_token === 'string'
        ? approval.resume_token
        : undefined;
    const normalizedApprovalStage = (
      approvalStage === 'plan'
      || approvalStage === 'creative'
      || approvalStage === 'video'
      || approvalStage === 'publish'
      || approvalStage === 'strategy'
      || approvalStage === 'production'
    )
      ? approvalStage
      : 'production';

    const normalized: HermesWorkflowOutput = {
      ok: typeof parsedRecord.ok === 'boolean' ? parsedRecord.ok : normalizedStatus !== 'failed',
      status: normalizedStatus,
      workflowKey: typeof parsedRecord.workflowKey === 'string' ? parsedRecord.workflowKey : BRAND_CAMPAIGN_WORKFLOW_KEY,
      workflowVersion: typeof parsedRecord.workflowVersion === 'string' ? parsedRecord.workflowVersion : undefined,
      runId: typeof parsedRecord.runId === 'string'
        ? parsedRecord.runId
        : typeof parsedRecord.run_id === 'string'
          ? parsedRecord.run_id
          : runId,
      output: (() => {
        const value = parsedRecord.output;
        if (Array.isArray(value)) {
          return value.filter(
            (entry): entry is Record<string, unknown> =>
              !!entry && typeof entry === 'object' && !Array.isArray(entry),
          );
        }
        return value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      })(),
      artifacts: undefined,
      approval: (workflowStepId && prompt)
        ? {
            stage: normalizedApprovalStage,
            workflowStepId,
            prompt,
            ...(approvalStep ? { approvalStep: approvalStep as SocialContentApprovalStep } : {}),
            resumeToken,
          }
        : undefined,
      error: parsedRecord.error && typeof parsedRecord.error === 'object'
        ? (() => {
            const err = parsedRecord.error as Record<string, unknown>;
            const message = typeof err.message === 'string' ? err.message : '';
            if (!message) return undefined;
            return {
              code: typeof err.code === 'string' ? err.code : undefined,
              message,
              retryable: typeof err.retryable === 'boolean' ? err.retryable : undefined,
            };
          })()
        : undefined,
    };

    if (!normalized.output) {
      const primary = { ...parsedRecord };
      delete primary.ok;
      delete primary.status;
      delete primary.workflowKey;
      delete primary.workflowVersion;
      delete primary.runId;
      delete primary.run_id;
      delete primary.output;
      delete primary.artifacts;
      delete primary.approval;
      delete primary.error;
      delete primary.requiresApproval;
      if (Object.keys(primary).length > 0) {
        normalized.output = primary;
      }
    }

    return normalized;
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
    workflowKey: string,
  ): string {
    if (action === 'run') {
      return [
        `Workflow: ${workflowKey}`,
        'Action: run',
        `Aries run ID: ${ariesRunId}`,
        `Job ID: ${input.jobId ?? ''}`,
        `Args (JSON): ${input.argsJson ?? '{}'}`,
      ].join('\n');
    }

    return [
      `Workflow: ${workflowKey}`,
      'Action: resume',
      `Aries run ID: ${ariesRunId}`,
      `Job ID: ${input.jobId ?? ''}`,
      `Approval ID: ${input.approvalId ?? ''}`,
      `Workflow step ID: ${input.workflowStepId ?? ''}`,
      `Resume token: ${input.resumeToken ?? ''}`,
      `Approve: ${input.approve === true}`,
    ].join('\n');
  }

  private instructions(workflowKey: string): string {
    return [
      'You are the Aries marketing execution agent.',
      'Reply with a single strict JSON object only — no prose, no markdown fences.',
      `Required schema: {"ok":true,"status":"completed","workflowKey":"${workflowKey}","output":[{...}]}.`,
      'If approval is required, set status to "requires_approval" and include approval.stage, approval.workflowStepId, approval.prompt, and approval.resumeToken.',
    ].join(' ');
  }
}
