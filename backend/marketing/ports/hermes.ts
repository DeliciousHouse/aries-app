import { createHash, randomBytes, randomUUID } from 'node:crypto';

import pool from '@/lib/db';
import { hashCallbackToken } from '@/lib/internal-callback-auth';
import {
  createExecutionRunRecord,
  markExecutionRunFailed,
  markExecutionRunSubmitted,
} from '../../execution/run-store';
import {
  handleHermesRunCallback,
  type HermesRunCallbackPayload,
  type HermesRunCallbackStatus,
} from '../../execution/hermes-callbacks';
import { isHonchoEnabled } from '../../memory/honcho-env';
import { TenantMemoryClient } from '../../memory/honcho-client';
import { HonchoHttpTransport } from '../../memory/honcho-http-transport';
import { createMemoryOrchestrator } from '../../memory/orchestrator';
import type { ResearchMemoryContextEntry } from '../../memory/orchestrator';
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
  RegenerateCreativeContext,
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

function generateIdempotencyKey(ariesRunId: string, workflowVersion: string, tenantId: string): string {
  return createHash('sha256')
    .update(`${ariesRunId}|${workflowVersion}|${tenantId}`)
    .digest('hex');
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
      regenerateCreative: input.regenerateCreative,
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

  private async loadMemoryContext(
    tenantId: string | undefined,
  ): Promise<ResearchMemoryContextEntry[] | undefined> {
    if (!isHonchoEnabled(this.env)) return undefined;
    if (!tenantId) return undefined;
    try {
      const transport = new HonchoHttpTransport(this.env);
      const client = new TenantMemoryClient(transport);
      const orchestrator = createMemoryOrchestrator(client);
      const ctx = { tenantId, tenantSlug: '', userId: 'system', role: 'tenant_admin' as const };
      const { memoryContext } = await orchestrator.loadResearchMemoryContext(ctx, {
        peers: [{ kind: 'brand' }, { kind: 'policy' }],
        tokenBudget: 2048,
      });
      return memoryContext.length > 0 ? memoryContext : undefined;
    } catch {
      return undefined;
    }
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
      regenerateCreative?: RegenerateCreativeContext;
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

    const memoryContextSnapshot = action === 'run'
      ? await this.loadMemoryContext(input.tenantId)
      : undefined;

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

    const payload = this.submissionPayload(
      action, run.aries_run_id, input, workflowKey, callbackToken, memoryContextSnapshot,
    );
    const idempotencyKey = typeof payload.idempotency_key === 'string' ? payload.idempotency_key : '';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl()}/v1/runs`, {
        method: 'POST',
        headers: {
          authorization: this.authHeader(),
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
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
      const responseBody = await response.text().catch(() => '');
      console.error('[hermes-port] gateway-rejected', {
        status: response.status,
        aries_run_id: run.aries_run_id,
        response_body: responseBody.slice(0, 1000),
        payload_keys: Object.keys(payload),
        idempotency_key_present: idempotencyKey.length > 0,
      });
      const message = `Hermes gateway returned HTTP ${response.status} on /v1/runs.`;
      markSubmissionFailed(run.aries_run_id, 'hermes_gateway_request_failed', message);
      return gatewayErrorResult(
        'hermes_gateway_request_failed',
        message,
        { status: response.status, aries_run_id: run.aries_run_id, body: responseBody.slice(0, 200) },
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
    // Hermes /v1/runs is a polled API — it never invokes the `callback_url`
    // field on the submission body. Without this bridge, marketing pipelines
    // submit successfully and then wait forever for a callback that the
    // gateway will not send. The bridge polls Hermes in the background until
    // the run reaches a terminal status, then invokes the callback handler
    // directly (we are already inside the trusted backend, so we skip the
    // HTTP route + auth and call the handler as a function).
    if (this.pollBridgeEnabled()) {
      const stage = input.stage ?? 'research';
      void this.runPollBridge(hermesRunId, run.aries_run_id, workflowKey, stage).catch((error) => {
        console.error('[hermes-port] poll-bridge failed', {
          aries_run_id: run.aries_run_id,
          hermes_run_id: hermesRunId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return {
      kind: 'submitted',
      provider: 'hermes',
      ariesRunId: run.aries_run_id,
      hermesRunId,
    };
  }

  private pollBridgeEnabled(): boolean {
    const raw = readEnvValue(this.env, 'HERMES_POLL_BRIDGE_ENABLED');
    // Default-on: Hermes /v1/runs does not fire callbacks. Set
    // HERMES_POLL_BRIDGE_ENABLED=0 to disable (e.g. for tests that don't
    // want background fetches).
    return raw !== '0' && raw !== 'false';
  }

  private async runPollBridge(
    hermesRunId: string,
    ariesRunId: string,
    workflowKey: string,
    stage: MarketingStage,
  ): Promise<void> {
    // Reuse the existing terminal-poller to drive Hermes to completion.
    // pollRunUntilTerminal already handles failure paths via markSubmissionFailed.
    const terminal = await this.pollRunUntilTerminal(hermesRunId, ariesRunId);

    const payload = this.buildBridgeCallbackPayload(
      ariesRunId,
      hermesRunId,
      workflowKey,
      stage,
      terminal,
    );
    if (!payload) {
      return;
    }

    const result = await handleHermesRunCallback(payload);
    if (result.status === 'error') {
      console.error('[hermes-port] poll-bridge callback rejected', {
        aries_run_id: ariesRunId,
        hermes_run_id: hermesRunId,
        reason: result.reason,
      });
    }
  }

  private buildBridgeCallbackPayload(
    ariesRunId: string,
    hermesRunId: string,
    workflowKey: string,
    stage: MarketingStage,
    terminal: MarketingExecutionResult,
  ): HermesRunCallbackPayload | null {
    const eventId = `bridge-${randomUUID()}`;
    const callbackStage = this.callbackStageForMarketingStage(stage);

    if (terminal.kind !== 'completed') {
      // pollRunUntilTerminal already marked the run failed via run-store.
      // Surface the failure to the orchestrator via the callback handler so
      // the stage record gets the error and history is appended.
      const errorMessage = 'Hermes run did not reach a successful terminal status.';
      return {
        event_id: eventId,
        aries_run_id: ariesRunId,
        hermes_run_id: hermesRunId,
        status: 'failed',
        stage: callbackStage,
        error: { code: 'hermes_run_terminal_error', message: errorMessage, retryable: false },
      };
    }

    const output = terminal.output;
    if (output.ok === false) {
      return {
        event_id: eventId,
        aries_run_id: ariesRunId,
        hermes_run_id: hermesRunId,
        status: 'failed',
        stage: callbackStage,
        error: {
          code: typeof output.error?.code === 'string' ? output.error.code : 'hermes_run_failed',
          message:
            typeof output.error?.message === 'string' && output.error.message.length > 0
              ? output.error.message
              : 'Hermes run failed without an error message.',
          retryable: output.error?.retryable === true,
        },
      };
    }

    const status: HermesRunCallbackStatus =
      output.approval && output.approval.workflowStepId
        ? 'requires_approval'
        : 'completed';

    const approval = output.approval && status === 'requires_approval'
      ? {
          stage: output.approval.stage,
          approval_step: output.approval.approvalStep,
          workflow_step_id: output.approval.workflowStepId,
          prompt: output.approval.prompt,
          resume_token: output.approval.resumeToken,
        }
      : undefined;

    const outputArray = Array.isArray(output.output) ? output.output : undefined;

    return {
      event_id: eventId,
      aries_run_id: ariesRunId,
      hermes_run_id: hermesRunId,
      status,
      stage: callbackStage,
      output: outputArray,
      ...(approval ? { approval } : {}),
    };
  }

  private callbackStageForMarketingStage(
    stage: MarketingStage,
  ): NonNullable<HermesRunCallbackPayload['stage']> {
    switch (stage) {
      case 'research':
        return 'research';
      case 'strategy':
        return 'strategy';
      case 'production':
        return 'production';
      case 'publish':
        return 'publish';
      default:
        return 'research';
    }
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
      regenerateCreative?: RegenerateCreativeContext;
    },
    workflowKey: string,
    callbackToken: string,
    memoryContextSnapshot?: ResearchMemoryContextEntry[],
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
      const idempotencyKey = generateIdempotencyKey(ariesRunId, SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY, input.tenantId ?? '');
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
        idempotency_key: idempotencyKey,
      };
    }

    if (action === 'run' && input.doc && isWeeklySocialContentRequest(input.doc)) {
      const request = buildSocialContentWeeklyRequest({
        doc: input.doc,
        ariesRunId,
        callbackUrl: this.callbackUrl(),
        regenerateCreative: input.regenerateCreative,
      });
      const idempotencyKey = generateIdempotencyKey(ariesRunId, request.workflow_version, input.tenantId ?? '');
      // Hermes /v1/runs is an OpenAI-style chat-completions endpoint: `input`
      // MUST be a string (or list of role/content messages). The structured
      // workflow request {brand, objective, competitor, ...} object that
      // `buildSocialContentWeeklyRequest` returns cannot go directly in `input`
      // — Hermes evaluates it as `not (str or list)` and 400s with
      // "No user message found in input". Serialize the full request into
      // a prompt string, same shape brand_campaign uses via `prompt()`.
      const prompt = [
        `Workflow: ${request.workflow_key}`,
        `Workflow version: ${request.workflow_version}`,
        'Action: run',
        `Aries run ID: ${request.aries_run_id}`,
        `Job ID: ${request.job_id}`,
        `Tenant ID: ${request.tenant_id}`,
        `Callback URL: ${request.callback_url}`,
        `Request (JSON): ${JSON.stringify(request)}`,
      ].join('\n');
      const promptWithMemory = memoryContextSnapshot && memoryContextSnapshot.length > 0
        ? `${prompt}\n\nMemory context (approved brand/policy findings):\n${JSON.stringify(memoryContextSnapshot)}`
        : prompt;
      return {
        input: promptWithMemory,
        instructions: this.instructions(request.workflow_key),
        session_id: this.sessionKey(),
        callback_url: request.callback_url,
        callback_auth: callbackAuth,
        callback_context: {
          workflow_key: request.workflow_key,
          workflow_version: request.workflow_version,
          aries_run_id: request.aries_run_id,
          job_id: request.job_id,
          tenant_id: request.tenant_id,
          ...(input.regenerateCreative
            ? {
                regenerate_creative: {
                  source_run_id: input.regenerateCreative.source_run_id,
                  source_creative_id: input.regenerateCreative.source_creative_id,
                },
              }
            : {}),
        },
        idempotency_key: idempotencyKey,
      };
    }

    const idempotencyKey = generateIdempotencyKey(ariesRunId, workflowKey, input.tenantId ?? '');
    const basePrompt = this.prompt(action, ariesRunId, input, workflowKey);
    const promptWithMemory = memoryContextSnapshot && memoryContextSnapshot.length > 0
      ? `${basePrompt}\n\nMemory context (approved brand/policy findings):\n${JSON.stringify(memoryContextSnapshot)}`
      : basePrompt;
    return {
      input: promptWithMemory,
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
      idempotency_key: idempotencyKey,
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
