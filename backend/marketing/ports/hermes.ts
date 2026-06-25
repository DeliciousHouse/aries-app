import { createHash, randomBytes, randomUUID } from 'node:crypto';

import pool from '@/lib/db';
import { hashCallbackToken } from '@/lib/internal-callback-auth';
import { PROTOCOL_VERSION } from '@aries/hermes-protocol';
import {
  createExecutionRunRecord,
  isTerminalExecutionStatus,
  loadExecutionRunRecord,
  markExecutionRunFailed,
  markExecutionRunSubmitted,
  type ExecutionRunRecord,
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
  buildProductionResumeContext,
  buildSocialContentWeeklyRequest,
  ensureFreshBrandKitForWeeklyRun,
} from '../../social-content/workflow-request';
import { isTasteBriefInjectionEnabled } from '../taste-brief-injection-env';
import { loadTasteForBriefByTenant, type TasteDimensions } from '../taste-profile-store';
import type {
  HermesWorkflowOutput,
  MarketingExecutionResult,
  MarketingExecutionPort,
  MarketingPipelineNextStageInput,
  MarketingPipelineResumeInput,
  MarketingPipelineRunInput,
  RegenerateCreativeContext,
  SocialContentApprovalStage,
  SubmitRawRunInput,
  SubmitRawRunResult,
} from '../execution-port';
import { loadSocialContentJobRuntime, type SocialContentJobRuntimeDocument, type MarketingStage } from '../runtime-state';
import type { SocialContentApprovalStep } from '@/backend/social-content/types';

type HermesCallbackTokenClient = {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
};

type HermesMarketingEnv = Partial<Record<string, string | undefined>>;
type HermesMarketingFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type HermesMarketingSleep = (ms: number) => Promise<void>;
type HermesBrandKitRefresher = (input: {
  doc: SocialContentJobRuntimeDocument;
  fetchImpl?: typeof fetch;
}) => Promise<{ refreshed: boolean; enriched: boolean }>;

const BRAND_CAMPAIGN_WORKFLOW_KEY = 'marketing_pipeline';

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 50;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);

/**
 * Phase B three-profile routing. Each marketing stage runs on a dedicated
 * Hermes profile, each bound to its own gateway port:
 *   - research           → aries-research          (web/search tools)
 *   - strategy / publish → aries-strategist         (pure LLM reasoning, no tools)
 *   - production         → aries-content-generator  (image_gen toolset)
 *
 * Hermes routes by per-profile API server port, so each profile is reached via
 * its own gateway URL + API key. Every per-profile env var falls back to
 * HERMES_GATEWAY_URL / HERMES_API_SERVER_KEY, so a deployment that has not set
 * the per-profile vars behaves exactly as the historical single-gateway setup.
 */
type HermesTargetProfile = 'aries-research' | 'aries-strategist' | 'aries-content-generator';

const STAGE_TO_PROFILE: Record<MarketingStage, HermesTargetProfile> = {
  research: 'aries-research',
  strategy: 'aries-strategist',
  production: 'aries-content-generator',
  publish: 'aries-strategist',
};

const PROFILE_GATEWAY_ENV: Record<HermesTargetProfile, { url: string; key: string }> = {
  'aries-research': { url: 'HERMES_RESEARCH_GATEWAY_URL', key: 'HERMES_RESEARCH_API_SERVER_KEY' },
  'aries-strategist': { url: 'HERMES_STRATEGIST_GATEWAY_URL', key: 'HERMES_STRATEGIST_API_SERVER_KEY' },
  'aries-content-generator': { url: 'HERMES_CONTENT_GATEWAY_URL', key: 'HERMES_CONTENT_API_SERVER_KEY' },
};

function targetProfileForStage(stage: MarketingStage | undefined): HermesTargetProfile {
  return stage ? STAGE_TO_PROFILE[stage] : 'aries-research';
}

function isHermesTargetProfile(value: unknown): value is HermesTargetProfile {
  return (
    value === 'aries-research'
    || value === 'aries-strategist'
    || value === 'aries-content-generator'
  );
}

/**
 * The marketing stage a resume transitions INTO, keyed by the approval step
 * being resolved. Used to recover the target profile when a caller resumes by
 * token only and does not pass an explicit stage (e.g. the resume-state
 * reseed path `replayMarketingPipelineToApprovalCheckpoint`). Without this a
 * stage-less resume would route to the research gateway and misroute a
 * strategy/production/publish transition in a per-profile deployment.
 */
const APPROVAL_STEP_TO_MARKETING_STAGE: Record<string, MarketingStage> = {
  approve_weekly_plan: 'strategy',
  approve_post_copy: 'production',
  approve_image_creatives: 'production',
  approve_publish: 'publish',
};

/**
 * Resolve the stage a resume targets. Prefers the explicit stage; otherwise
 * infers it from the approval step. Returns undefined only when neither is
 * known — callers then fall back to the default gateway.
 */
function resumeStageFromInput(
  stage: MarketingStage | undefined,
  approvalStep: SocialContentApprovalStep | null | undefined,
): MarketingStage | undefined {
  if (stage) return stage;
  if (approvalStep && APPROVAL_STEP_TO_MARKETING_STAGE[approvalStep]) {
    return APPROVAL_STEP_TO_MARKETING_STAGE[approvalStep];
  }
  return undefined;
}

/**
 * Returns true for job types that use the per-stage profile pipeline
 * (strategy/production/publish each run on their own Hermes profile,
 * and each stage's output is forwarded as input to the next stage).
 * Both weekly_social_content and one_off_campaign use this pipeline.
 * BRAND_CAMPAIGN_WORKFLOW_KEY (marketing_pipeline) is the only exception.
 */
function usesPerStageProfilePipeline(doc?: SocialContentJobRuntimeDocument): boolean {
  const request = doc?.inputs?.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return false;
  }
  const jobType = (request as Record<string, unknown>).jobType;
  return jobType === 'weekly_social_content' || jobType === 'one_off_post' || jobType === 'one_off_campaign';
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

// --- Per-stage instruction fragments (shared across weekly + brand) ---------

const RESEARCH_TOOL_POLICY =
  'Research stage tool policy: during the research stage you may use ONLY these tools: web_extract, web_search, and the last30days Hermes skill. You MUST NOT call read_file, search_files, write_file, execute_code, or terminal. There is no Aries workspace available to this agent — calling local-workspace tools will loop until the 600s "did not reach a terminal status" timeout fires. Required tool sequence: (1) call web_extract once for the brand URL when present, (2) call web_search once for the brand, (3) if a competitor URL or competitor brand is provided, call web_extract once for the competitor URL and web_search once for the competitor, (4) optionally invoke `/last30days` for the brand and (if a competitor URL or competitor brand is provided) for the competitor. Do not exceed 6 total tool calls during the research stage. After these tool calls, stop using tools and return the strict JSON checkpoint immediately.';

const LAST30DAYS_GUIDANCE = [
  'Use the `last30days` Hermes skill (slash command `/last30days <topic>`) to research what people are saying about each brand in the last 30 days. Do NOT shell out to terminal for last30days — invoke it as a slash command.',
  'Derive the topic from the domain name (e.g. `https://sugarandleather.com` → "Sugar and Leather").',
  'Invoke `/last30days` for the brand, and — if a competitor URL or competitor brand is provided — for the competitor separately.',
  'Fold the social-signal findings from `last30days` into the research output artifacts.',
];

const PRODUCTION_EXECUTION_CONTRACT =
  'PRODUCTION STAGE EXECUTION CONTRACT: When the input contains "Production context (N images requested)", you MUST return BOTH content_package[] AND artifacts.creative_assets[]. One without the other is incomplete and will fail downstream publish. (A) Call the `image_generate` tool exactly once per image listed — do not return JSON until every image_generate call has completed. (B) Build content_package[] with one entry per post: {post_number, theme, hook, body, cta, hashtags (array of 3-6 relevant hashtags), platforms, format, visual_prompt}. The Nth creative_asset corresponds to the Nth content_package post via post_number. content_package carries the post COPY (caption text, hooks, hashtags). creative_assets carries the rendered IMAGES. Return output:[{stage:"production", content_package:[{post_number:1, theme:"...", hook:"...", body:"...", cta:"...", hashtags:["#tag1","#tag2","#tag3"], platforms:["instagram","facebook"], format:"single_image", visual_prompt:"..."},...], artifacts:{creative_assets:[{assetId:"img_1", type:"generated_image", path:<absolute path returned by image_generate>, prompt:<the rendered visual prompt>, placement:<which post number>}, ...], errors:[]}}]. If image_generate returns success:false for an item, record it in artifacts.errors[] and continue.';

/** Instructs the production agent how to return video clips alongside images.
 * Kept as a named export so workflow-request.ts can append it to the resume
 * context block without re-stating the schema (single source of truth).
 */
export const VIDEO_EXECUTION_CONTRACT =
  'VIDEO EXECUTION CONTRACT: When the input contains "Video context (N videos requested)", you MUST call the `video_generate` tool exactly once per video listed — do not return JSON until every video_generate call has completed (or definitively failed). This is exactly as mandatory as the image_generate contract above: generate the video(s) IN ADDITION to the requested images, never instead of them, and a requested video that produces neither a creative_asset nor an artifacts.errors[] entry is a stage failure. The video clip is always the FINAL post in the package (the highest post_number), appended after the image posts. Return each generated clip in artifacts.creative_assets[] alongside the image assets — do NOT skip failed clips, record them in artifacts.errors[] instead (resumability rule). Each video entry in creative_assets MUST include: {assetId:"vid_1", type:"generated_video", media_type:"video", surface:"reel"|"story", path:"<basename of the localized mp4 written to the Hermes VIDEO cache — NOT a remote CDN URL>", width:<integer px — MANDATORY>, height:<integer px — MANDATORY>, duration_seconds:<number — MANDATORY>, mime:"video/mp4", aspect_ratio:"9:16"}. The path, width, height, and duration_seconds MUST be copied from the video_generate tool RETURN VALUE (the real localized file), never the values you requested — a mismatch fails closed at dispatch and the clip will not publish. RETURN-GATE (do this before returning your JSON): re-read the input; for "Video context (N videos requested)", artifacts.creative_assets MUST contain exactly N generated_video entries OR a matching artifacts.errors[] entry per missing clip. If the count is short you are NOT finished — call video_generate for the missing clip(s) now and do not return until the count matches. Record render failures in artifacts.errors[] and continue.';

/**
 * Per-stage instruction builders for the weekly social-content pipeline.
 *
 * Phase B3: each marketing stage runs on its own dedicated Hermes profile, so
 * each builder ships ONLY that stage's contract — the strategist profile never
 * sees image_generate instructions, the content-generator profile never sees
 * research tool policy. Strategy/production/publish are dispatched as fresh
 * `action: run` POSTs carrying the prior stage's output as `input`, because a
 * resume_token issued by one profile's gateway cannot resume on another.
 */
function buildWeeklyResearchInstructions(workflowKey: string): string {
  return [
    'You are the Aries marketing research agent. You run ONLY the research stage of the weekly social content pipeline.',
    RESEARCH_TOOL_POLICY,
    ...LAST30DAYS_GUIDANCE,
    'Reply with a single strict JSON object only — no prose, no markdown fences.',
    'After completing the research stage, return status "requires_approval" with approval.stage="strategy", approval.approval_step="approve_weekly_plan", approval.workflowStepId="approve_stage_2", approval.prompt="Review research findings before strategy starts", approval.resumeToken set, and output:[{stage:"research", ...artifacts}].',
    `Required schema: {"ok":true,"status":"requires_approval","workflowKey":"${workflowKey}","approval":{"stage":"strategy","approval_step":"approve_weekly_plan","workflowStepId":"approve_stage_2","prompt":"...","resumeToken":"..."},"output":[{"stage":"research", ...}]}.`,
  ].join(' ');
}

function buildWeeklyStrategyInstructions(workflowKey: string): string {
  return [
    'You are the Aries marketing strategist agent. You run ONLY the strategy stage of the weekly social content pipeline.',
    'You have no tools — you reason purely over the research output supplied in the input. Do not attempt to call any tools; this stage is pure reasoning.',
    'The input contains the prior research stage output as JSON. Produce a weekly content strategy from it: positioning, creative direction, channel adaptation, and a post-by-post plan.',
    'Reply with a single strict JSON object only — no prose, no markdown fences.',
    'After completing the strategy stage, return status "requires_approval" with approval.stage="production", approval.approval_step="approve_post_copy", approval.workflowStepId="approve_stage_3", approval.prompt="Review strategy before production starts", approval.resumeToken set, and output:[{stage:"strategy", ...artifacts}].',
    `Required schema: {"ok":true,"status":"requires_approval","workflowKey":"${workflowKey}","approval":{"stage":"production","approval_step":"approve_post_copy","workflowStepId":"approve_stage_3","prompt":"...","resumeToken":"..."},"output":[{"stage":"strategy", ...}]}.`,
  ].join(' ');
}

function buildWeeklyProductionInstructions(workflowKey: string): string {
  return [
    'You are the Aries content-generation agent. You run ONLY the production stage of the weekly social content pipeline.',
    'Your job is to generate images and post copy, plus any requested video. The input carries per-image prompt context and the strategy output.',
    'Follow the `social-image-creative` skill for each image post and the `social-video-creative` skill for each requested video clip — they define the exact per-platform format (scale/aspect/duration), the mandatory image_generate / video_generate call, and the placement stamping. Image and video use DIFFERENT scales (feed image vs 9:16 reel); do not reuse one for the other.',
    PRODUCTION_EXECUTION_CONTRACT,
    VIDEO_EXECUTION_CONTRACT,
    'After completing the production stage, return status "requires_approval" with approval.stage="publish", approval.approval_step="approve_publish", approval.workflowStepId="approve_stage_4", approval.prompt="Review creative assets before publish review", approval.resumeToken set, and output:[{stage:"production", ...artifacts}].',
    `Required schema: {"ok":true,"status":"requires_approval","workflowKey":"${workflowKey}","approval":{"stage":"publish","approval_step":"approve_publish","workflowStepId":"approve_stage_4","prompt":"...","resumeToken":"..."},"output":[{"stage":"production", ...}]}.`,
  ].join(' ');
}

function buildWeeklyPublishInstructions(workflowKey: string): string {
  return [
    'You are the Aries publish-review agent. You run ONLY the publish stage of the weekly social content pipeline.',
    'You have no tools — you reason purely over the production output supplied in the input. Produce a publish-ready plan: per-post platform targeting, scheduling notes, and a final pre-flight check.',
    'Reply with a single strict JSON object only — no prose, no markdown fences.',
    'After completing the publish stage, return status "requires_approval" with approval.stage="publish", approval.approval_step="approve_publish", approval.workflowStepId="approve_stage_4_publish", approval.prompt="Approve to publish the weekly social content", approval.resumeToken set, and output:[{stage:"publish", ...artifacts}].',
    `Required schema: {"ok":true,"status":"requires_approval","workflowKey":"${workflowKey}","approval":{"stage":"publish","approval_step":"approve_publish","workflowStepId":"approve_stage_4_publish","prompt":"...","resumeToken":"..."},"output":[{"stage":"publish", ...}]}.`,
  ].join(' ');
}

/**
 * Terminal publish run. The publish stage has two checkpoints: the first
 * publish run emits `approve_stage_4_publish` (handled by
 * buildWeeklyPublishInstructions); once that approval is granted, the FINAL
 * publish run must close the pipeline by returning a terminal `completed`
 * envelope with NO approval object. Without this, the resume→run conversion
 * would make every publish run re-emit `requires_approval`, and the orchestrator
 * + auto-approve would loop the publish stage indefinitely.
 */
function buildWeeklyPublishFinalizeInstructions(workflowKey: string): string {
  return [
    'You are the Aries publish-finalize agent. The weekly social content publish review has ALREADY been approved.',
    'You have no tools. Reason over the publish plan supplied in the input and emit the final pipeline result.',
    'Reply with a single strict JSON object only — no prose, no markdown fences.',
    'This is the FINAL stage. Return status "completed" with NO approval object — the publish review is already approved and the pipeline is finished. Do not ask for any further approval.',
    `Required schema: {"ok":true,"status":"completed","workflowKey":"${workflowKey}","output":[{"stage":"publish", ...artifacts}]}.`,
  ].join(' ');
}

const WEEKLY_STAGE_INSTRUCTION_BUILDERS: Record<MarketingStage, (workflowKey: string) => string> = {
  research: buildWeeklyResearchInstructions,
  strategy: buildWeeklyStrategyInstructions,
  production: buildWeeklyProductionInstructions,
  publish: buildWeeklyPublishInstructions,
};

/**
 * The workflow step id for the FINAL publish approval. A weekly publish resume
 * carrying this step is the post-approval finalize run and must terminate the
 * pipeline; any other publish resume is the first publish run.
 */
const FINAL_PUBLISH_WORKFLOW_STEP_ID = 'approve_stage_4_publish';

/**
 * Stage-scoped instructions. The weekly social pipeline is decomposed into
 * three profiles, so it gets a short per-stage builder. The brand-campaign
 * (`marketing_pipeline`) path keeps the single combined instruction set — it
 * is not being decomposed.
 *
 * `workflowStepId` distinguishes the two publish checkpoints: the final
 * publish resume (`approve_stage_4_publish`) gets the terminal finalize
 * instructions; the first publish run gets the normal publish instructions.
 */
export function buildHermesStageInstructions(
  workflowKey: string,
  stage: MarketingStage,
  workflowStepId?: string | null,
): string {
  if (workflowKey === SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY) {
    if (stage === 'publish' && workflowStepId === FINAL_PUBLISH_WORKFLOW_STEP_ID) {
      return buildWeeklyPublishFinalizeInstructions(workflowKey);
    }
    return WEEKLY_STAGE_INSTRUCTION_BUILDERS[stage](workflowKey);
  }
  return buildHermesInstructions(workflowKey);
}

/**
 * Exported for snapshot tests only — callers should use HermesMarketingPort.
 *
 * The weekly social pipeline now routes per stage via buildHermesStageInstructions;
 * this combined form is retained for the non-weekly `marketing_pipeline`
 * (brand campaign) path and for legacy snapshot tests. When called with the
 * weekly workflow key it returns the research-stage instructions, which carry
 * the research tool policy the legacy snapshot tests assert.
 */
export function buildHermesInstructions(workflowKey: string): string {
  if (workflowKey === SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY) {
    return buildWeeklyResearchInstructions(workflowKey);
  }
  return [
    'You are the Aries marketing execution agent.',
    RESEARCH_TOOL_POLICY,
    ...LAST30DAYS_GUIDANCE,
    'Reply with a single strict JSON object only — no prose, no markdown fences.',
    PRODUCTION_EXECUTION_CONTRACT,
    `Required schema: {"ok":true,"status":"completed","workflowKey":"${workflowKey}","output":[{...}]}.`,
    'If approval is required, set status to "requires_approval" and include approval.stage, approval.workflowStepId, approval.prompt, and approval.resumeToken.',
  ].join(' ');
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
/**
 * Outcome of reconciling one execution run. `pending` means "not terminal yet,
 * try next tick"; `ingested` means a terminal Hermes result was delivered to the
 * callback handler (duplicate=true if the event was already applied).
 */
export type ReconcileRunOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'pending' }
  | { status: 'ingested'; callbackStatus: HermesRunCallbackStatus; duplicate: boolean }
  | { status: 'error'; reason: string };

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
    doc: SocialContentJobRuntimeDocument,
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

  async submitNextStage(input: MarketingPipelineNextStageInput): Promise<MarketingExecutionResult> {
    return this.invoke('run', {
      jobId: input.jobId,
      tenantId: input.tenantId,
      doc: input.doc,
      argsJson: JSON.stringify({ auto_advance: true, starting_stage: input.stage }),
      stage: input.stage,
    });
  }

  getCallbackUrl(): string {
    return this.callbackUrl();
  }

  getSessionKey(): string {
    return this.sessionKey();
  }

  async submitRawRun(input: SubmitRawRunInput): Promise<SubmitRawRunResult> {
    const configError = this.configurationError();
    if (configError) {
      const keys = ['HERMES_GATEWAY_URL', 'HERMES_API_SERVER_KEY', 'INTERNAL_API_SECRET', 'APP_BASE_URL']
        .filter((key) => !readEnvValue(this.env, key));
      markSubmissionFailed(input.ariesRunId, 'hermes_gateway_not_configured', `${keys.join(', ')} required for Hermes execution.`);
      throw new Error(`hermes_gateway_not_configured:${keys.join(', ')} required for Hermes execution.`);
    }

    await this.persistCallbackTokenHash(input.ariesRunId, input.tenantId, input.callbackToken);

    // Always stamp protocol_version at the chokepoint so callers that build
    // their own payload objects (e.g. submitSocialCopyFinalizeRun) can't
    // accidentally omit it.
    const wirePayload: Record<string, unknown> = { ...input.payload, protocol_version: PROTOCOL_VERSION };
    const idempotencyKey = typeof wirePayload.idempotency_key === 'string' ? wirePayload.idempotency_key : '';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl()}/v1/runs`, {
        method: 'POST',
        headers: {
          authorization: this.authHeader(),
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(wirePayload),
      });
    } catch (error) {
      markSubmissionFailed(input.ariesRunId, 'hermes_gateway_unreachable', error instanceof Error ? error.message : String(error));
      throw new Error(`hermes_gateway_unreachable:${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      markSubmissionFailed(input.ariesRunId, 'hermes_gateway_request_failed', `Hermes gateway returned HTTP ${response.status} on /v1/runs.`);
      throw new Error(`hermes_gateway_request_failed:HTTP ${response.status} ${responseBody.slice(0, 200)}`);
    }

    const parsed = await this.parseJsonBody(response);
    const hermesRunId = typeof parsed?.run_id === 'string' ? parsed.run_id.trim() : '';
    if (!hermesRunId) {
      markSubmissionFailed(input.ariesRunId, 'hermes_gateway_response_invalid', 'Hermes /v1/runs response is missing run_id.');
      throw new Error('hermes_gateway_response_invalid:Hermes /v1/runs response is missing run_id.');
    }

    // submitRawRun posts to the DEFAULT gateway (this.gatewayUrl()), so record
    // target_profile=null — the reconciler must poll that same default gateway,
    // not a stage-derived per-profile one.
    markExecutionRunSubmitted(input.ariesRunId, { externalRunId: hermesRunId, targetProfile: null });
    if (this.pollBridgeEnabled()) {
      void this.runPollBridge(hermesRunId, input.ariesRunId, input.workflowKey, input.stage).catch((error) => {
        console.error('[hermes-port] poll-bridge failed (submitRawRun)', {
          aries_run_id: input.ariesRunId,
          hermes_run_id: hermesRunId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return { ariesRunId: input.ariesRunId, hermesRunId };
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

  /**
   * Resolve the gateway URL for a marketing stage's dedicated Hermes profile.
   * Falls back to HERMES_GATEWAY_URL when the per-profile var is unset, so a
   * single-gateway deployment is unaffected.
   */
  private gatewayUrlForProfile(profile: HermesTargetProfile): string {
    const specific = readEnvValue(this.env, PROFILE_GATEWAY_ENV[profile].url);
    const url = specific || readEnvValue(this.env, 'HERMES_GATEWAY_URL');
    return url.replace(/\/+$/, '');
  }

  private authHeaderForProfile(profile: HermesTargetProfile): string {
    const specific = readEnvValue(this.env, PROFILE_GATEWAY_ENV[profile].key);
    const key = specific || readEnvValue(this.env, 'HERMES_API_SERVER_KEY');
    return `Bearer ${key}`;
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
      doc?: SocialContentJobRuntimeDocument;
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

    // Phase B3: a weekly-pipeline DENIAL (resume + approve === false) has
    // nothing to cancel on Hermes. By the time a stage emits an approval
    // checkpoint its Hermes run has already COMPLETED — there is no paused
    // run sitting on a gateway. With per-profile routing the denial POST
    // would also carry a resume_token the target gateway never issued and is
    // guaranteed to 4xx, baking a misleading gateway-rejected error into the
    // logs on every denial. A weekly denial is purely an Aries-side state
    // transition (the orchestrator marks the job failed locally), so skip the
    // POST — and the execution-run record / callback-token row — entirely.
    // Return a synthetic `cancelled` envelope: the orchestrator deny path
    // requires envelope.status === 'cancelled' (else it throws
    // workflow_deny_failed) and then records the denial itself.
    if (
      action === 'resume'
      && this.workflowKeyFor(action, input) === SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY
      && input.approve === false
    ) {
      return {
        kind: 'completed',
        provider: 'hermes',
        output: {
          ok: true,
          status: 'cancelled',
          workflowKey: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
        },
      };
    }

    if (action === 'run' && input.doc && usesPerStageProfilePipeline(input.doc)) {
      const brandKitFailure = await this.refreshBrandKitOrFail(input.doc);
      if (brandKitFailure) {
        return brandKitFailure;
      }
    }
    const workflowKey = this.workflowKeyFor(action, input);

    const memoryContextSnapshot = action === 'run'
      ? await this.loadMemoryContext(input.tenantId)
      : undefined;

    // Resolve the effective stage. A caller that resumes by token only (e.g.
    // the resume-state reseed path replayMarketingPipelineToApprovalCheckpoint)
    // passes no explicit stage; infer it from the approval step so per-profile
    // routing targets the correct gateway instead of defaulting to research.
    const approvalStepForContext =
      input.approvalStep ??
      (input.workflowStepId ? approvalStepFromWorkflowStepId(input.workflowStepId) : null);
    const effectiveStage =
      action === 'resume'
        ? resumeStageFromInput(input.stage, approvalStepForContext)
        : input.stage;
    const resolvedInput = effectiveStage !== input.stage
      ? { ...input, stage: effectiveStage }
      : input;

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey,
      action,
      tenantId: input.tenantId,
      marketingJobId: input.jobId,
      approvalId: input.approvalId,
      stage: effectiveStage ?? null,
      workflowStepId: input.workflowStepId,
    });

    const callbackToken = randomBytes(32).toString('hex');
    await this.persistCallbackTokenHash(run.aries_run_id, input.tenantId, callbackToken);

    // Phase B3: a weekly resume (strategy/production/publish) is converted into
    // a fresh `action: run` on the stage's dedicated profile gateway — a
    // resume_token issued by one gateway cannot resume on another. To do that
    // we must carry the PRIOR stage's output as the new run's input, so load
    // the job doc for every weekly resume (not just the production resume).
    // loadSocialContentJobRuntime returns null if the doc is missing — the prompt
    // builders handle that gracefully and fall back to static brand data.
    const isWeeklyResume =
      action === 'resume' && workflowKey === SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY;
    const productionDoc = isWeeklyResume && input.jobId
      ? await loadSocialContentJobRuntime(input.jobId).catch(() => null)
      : null;

    // PR2: preload the per-tenant taste projection here (async, tenantId in
    // scope) so the synchronous submissionPayload/buildProductionResumeContext
    // does no DB read. Flag-gated + fail-open: a taste read failure must never
    // block a production submission, so it degrades to null (byte-identical brief).
    const tasteProjection = isWeeklyResume && input.tenantId && isTasteBriefInjectionEnabled()
      ? await loadTasteForBriefByTenant(input.tenantId).catch(() => null)
      : null;

    const payload = this.submissionPayload(
      action, run.aries_run_id, resolvedInput, workflowKey, callbackToken, memoryContextSnapshot, productionDoc, tasteProjection,
    );
    const idempotencyKey = typeof payload.idempotency_key === 'string' ? payload.idempotency_key : '';

    // Route this stage's submission to its dedicated Hermes profile gateway.
    // Defaults to HERMES_GATEWAY_URL when per-profile vars are unset.
    const targetProfile = targetProfileForStage(effectiveStage);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrlForProfile(targetProfile)}/v1/runs`, {
        method: 'POST',
        headers: {
          authorization: this.authHeaderForProfile(targetProfile),
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

    // invoke() posts to the per-profile gateway (gatewayUrlForProfile(targetProfile)),
    // so record that profile — the reconciler polls the same gateway later.
    markExecutionRunSubmitted(run.aries_run_id, { externalRunId: hermesRunId, targetProfile });
    if (this.syncPollingEnabled()) {
      return this.pollRunUntilTerminal(hermesRunId, run.aries_run_id, targetProfile);
    }
    // Hermes /v1/runs is a polled API — it never invokes the `callback_url`
    // field on the submission body. Without this bridge, marketing pipelines
    // submit successfully and then wait forever for a callback that the
    // gateway will not send. The bridge polls Hermes in the background until
    // the run reaches a terminal status, then invokes the callback handler
    // directly (we are already inside the trusted backend, so we skip the
    // HTTP route + auth and call the handler as a function).
    if (this.pollBridgeEnabled()) {
      const stage = effectiveStage ?? 'research';
      void this.runPollBridge(hermesRunId, run.aries_run_id, workflowKey, stage, targetProfile).catch((error) => {
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
    profile?: HermesTargetProfile,
  ): Promise<void> {
    // Reuse the existing terminal-poller to drive Hermes to completion.
    // pollRunUntilTerminal already handles failure paths via markSubmissionFailed.
    // The poll must hit the same gateway the run was submitted to — callers that
    // routed to a per-profile gateway pass that profile through.
    const terminal = await this.pollRunUntilTerminal(hermesRunId, ariesRunId, profile);

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

  /**
   * Durable, out-of-request reconciliation of a single execution run.
   *
   * The in-process poll-bridge (runPollBridge) is a fire-and-forget promise
   * spawned by the request that submitted the run; in the Next.js prod runtime
   * it is not guaranteed to survive long enough to deliver, so completed Hermes
   * runs are never ingested and the stale-run reaper eventually fails the job.
   * This method is the durable replacement: it is called by a dedicated worker
   * process (scripts/hermes-reconciler-worker.ts) that re-discovers in-flight
   * runs from disk every tick, so it does not depend on any request lifecycle.
   *
   * It performs ONE Hermes status GET (not the 20-minute terminal poll). If the
   * run is not yet terminal it returns `pending` and the next tick retries. If
   * it is terminal it drives the SAME idempotent callback path the bridge uses
   * (handleHermesRunCallback). The deterministic event_id (reconcile-<hermesRunId>)
   * makes repeated RECONCILER passes a no-op. It does NOT dedupe against a
   * still-alive in-process bridge (that uses a random bridge-<uuid> event_id) —
   * that coexistence is safe instead via the per-run file lock plus the
   * callback handler's terminal-immutability and already-terminal-doc guards,
   * which drop a redundant second delivery.
   */
  async reconcileExecutionRun(
    ariesRunId: string,
    opts: { record?: ExecutionRunRecord } = {},
  ): Promise<ReconcileRunOutcome> {
    // The sweep already loaded the record from disk; reuse it to avoid a second
    // readFile+JSON.parse per candidate. handleHermesRunCallback re-loads under
    // the per-run lock for the authoritative write, so a slightly-stale record
    // here only affects the cheap pre-poll guards (which the callback's terminal
    // guards + deterministic event_id make idempotent anyway).
    const record = opts.record ?? loadExecutionRunRecord(ariesRunId);
    if (!record) {
      return { status: 'skipped', reason: 'not_found' };
    }
    if (record.provider !== 'hermes') {
      return { status: 'skipped', reason: 'non_hermes' };
    }
    if (record.domain !== 'marketing') {
      // Only marketing runs carry the stage→profile + ingestion semantics this
      // path reconstructs. Route-domain runs are left untouched.
      return { status: 'skipped', reason: 'non_marketing' };
    }
    if (isTerminalExecutionStatus(record.status)) {
      return { status: 'skipped', reason: 'already_terminal' };
    }
    if (record.status === 'awaiting_approval') {
      // A requires_approval callback already landed; the run is legitimately
      // paused. Re-polling Hermes would only re-deliver the same approval.
      return { status: 'skipped', reason: 'awaiting_approval' };
    }
    const hermesRunId = record.external_run_id;
    if (!hermesRunId) {
      // Never reached Hermes (submission failed before run_id). Nothing to poll;
      // the reaper handles genuinely-dead never-submitted runs.
      return { status: 'skipped', reason: 'not_submitted' };
    }
    const stage = record.stage;
    if (!stage) {
      return { status: 'skipped', reason: 'no_stage' };
    }

    // Poll the gateway the run was actually submitted to. Records written since
    // profile persistence carry target_profile: null = default gateway
    // (submitRawRun), or a profile name = per-profile gateway (invoke). Records
    // that predate persistence (target_profile undefined) fall back to deriving
    // from stage. That fallback is exact for invoke-path runs (which dominate
    // the in-flight set); a pre-persistence submitRawRun run — only
    // social_copy_finalize today, which is default OFF, so none exist — would
    // misroute to the stage gateway, harmlessly 404→pending until the reaper
    // clears it. An unrecognized stored value also falls back to stage-derived
    // rather than crashing gatewayUrlForProfile.
    let profile: HermesTargetProfile | null;
    if (record.target_profile === undefined) {
      profile = STAGE_TO_PROFILE[stage];
    } else if (record.target_profile === null) {
      profile = null;
    } else if (isHermesTargetProfile(record.target_profile)) {
      profile = record.target_profile;
    } else {
      profile = STAGE_TO_PROFILE[stage];
    }
    const polled = await this.pollRunOnce(hermesRunId, profile);
    if (polled.kind !== 'terminal') {
      // pending (still running) or transient (gateway hiccup / not-yet-indexed):
      // leave the run untouched for the next tick. We deliberately do NOT mark
      // the run failed on a transient error — the reaper is the backstop for
      // genuinely-dead runs, and a flaky GET must not lose a completed run.
      return { status: 'pending' };
    }

    const terminal = this.resultFromTerminalRun(hermesRunId, ariesRunId, polled.record);
    const payload = this.buildBridgeCallbackPayload(
      ariesRunId,
      hermesRunId,
      record.workflow_key,
      stage,
      terminal,
      `reconcile-${hermesRunId}`,
    );
    if (!payload) {
      return { status: 'skipped', reason: 'no_payload' };
    }

    const result = await handleHermesRunCallback(payload);
    if (result.status === 'error') {
      // A live in-process bridge / concurrent callback holds the per-run lock.
      // Benign — retry on the next tick.
      if (result.reason === 'execution_run_locked') {
        return { status: 'pending' };
      }
      return { status: 'error', reason: result.reason };
    }
    return { status: 'ingested', callbackStatus: payload.status, duplicate: result.duplicate === true };
  }

  /**
   * Single Hermes status GET against the gateway the run was submitted to
   * (null profile → default gateway). Unlike pollRunUntilTerminal this never
   * loops and never marks the run failed — it just classifies the current
   * status so the reconciler can decide per tick. A bounded AbortController
   * timeout keeps one wedged gateway connection from stalling the whole
   * sequential sweep (a stall would delay ingesting every other in-flight run).
   */
  private async pollRunOnce(
    runId: string,
    profile: HermesTargetProfile | null,
  ): Promise<
    | { kind: 'pending' }
    | { kind: 'transient' }
    | { kind: 'terminal'; record: Record<string, unknown> }
  > {
    const gatewayUrl = profile ? this.gatewayUrlForProfile(profile) : this.gatewayUrl();
    const authHeader = profile ? this.authHeaderForProfile(profile) : this.authHeader();
    const timeoutMs = readEnvInt(this.env, 'HERMES_RECONCILER_POLL_TIMEOUT_MS', 15_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${gatewayUrl}/v1/runs/${encodeURIComponent(runId)}`,
        { method: 'GET', headers: { authorization: authHeader }, signal: controller.signal },
      );
    } catch {
      return { kind: 'transient' };
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      return { kind: 'transient' };
    }
    const record = await this.parseJsonBody(response);
    if (!record || typeof record.status !== 'string') {
      return { kind: 'transient' };
    }
    if (TERMINAL_STATUSES.has(record.status)) {
      return { kind: 'terminal', record };
    }
    return { kind: 'pending' };
  }

  private buildBridgeCallbackPayload(
    ariesRunId: string,
    hermesRunId: string,
    workflowKey: string,
    stage: MarketingStage,
    terminal: MarketingExecutionResult,
    // The in-process bridge fires once per submission, so a random event_id is
    // fine. The durable reconciler re-polls the SAME run every tick, so it must
    // pass a DETERMINISTIC event_id (reconcile-<hermesRunId>) — otherwise each
    // pass would bypass handleHermesRunCallback's event_id dedup and re-apply.
    eventId: string = `bridge-${randomUUID()}`,
  ): HermesRunCallbackPayload | null {
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

    // Hermes inconsistently emits two completing-stage shapes:
    //   (a) transition descriptor "X_to_Y" — handled in pre-filter
    //       (workflowOutputFromRunRecord) which parses Y as the canonical
    //       next-stage. Observed for research-stage completion in prod
    //       (e.g. "research_to_strategy").
    //   (b) bare current-stage name — observed for strategy-stage completion
    //       in prod (e.g. emits "strategy" when the strategy run finishes
    //       and pauses for production approval). Pre-filter accepts "strategy"
    //       as canonical and passes it through unchanged because it has no
    //       knowledge of the current run.stage.
    // The validator expects NEXT-stage, so (b) needs a second-pass mapping
    // here in the bridge where we DO know the current run.stage. If
    // approval.stage matches the current stage, treat it as completing-stage
    // and remap to next.
    type ApprovalStage = NonNullable<HermesRunCallbackPayload['approval']>['stage'];
    const COMPLETING_TO_NEXT_BRIDGE: Record<MarketingStage, ApprovalStage | undefined> = {
      research: 'strategy',
      strategy: 'production',
      production: 'publish',
      publish: undefined,
    };
    const rawApprovalStage = output.approval?.stage;
    const isCompletingStageEmission =
      typeof rawApprovalStage === 'string' && rawApprovalStage === stage;
    const approvalStageFinal: ApprovalStage | undefined = isCompletingStageEmission
      ? (COMPLETING_TO_NEXT_BRIDGE[stage] ?? (rawApprovalStage as ApprovalStage))
      : (rawApprovalStage as ApprovalStage | undefined);

    const approval = output.approval && status === 'requires_approval'
      ? {
          stage: approvalStageFinal as ApprovalStage,
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
      doc?: SocialContentJobRuntimeDocument;
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
    /** Pre-loaded marketing job doc, used for production-resume rich prompt injection. */
    productionDoc?: SocialContentJobRuntimeDocument | null,
    /** Pre-loaded per-tenant taste projection (PR2), spliced into the production brief. */
    tasteProjection?: TasteDimensions | null,
  ): Record<string, unknown> {
    const callbackAuth = {
      type: 'internal_api_secret_bearer',
      secret_ref: 'INTERNAL_API_SECRET',
      callback_token: callbackToken,
    };

    // Phase B3: an APPROVED weekly resume (approve === true) advances the
    // pipeline. Because each stage runs on its own profile gateway and resume
    // tokens do not cross gateways, the strategy/production/publish "resume" is
    // converted into a fresh `action: run` on the dedicated profile, carrying
    // the PRIOR stage's output as the run input. A DENIED weekly resume
    // (approve === false) does NOT advance — it is a cancel signal — so it
    // keeps the legacy `action: resume` shape below; the orchestrator marks the
    // job failed regardless of the gateway response.
    if (
      action === 'resume'
      && workflowKey === SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY
      && input.approve === true
    ) {
      const approvalStep =
        input.approvalStep ??
        approvalStepFromWorkflowStepId(input.workflowStepId ?? '') ??
        null;
      const stage: MarketingStage = input.stage ?? 'strategy';
      const idempotencyKey = generateIdempotencyKey(ariesRunId, SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY, input.tenantId ?? '');

      // The publish stage has two checkpoints. A resume carrying the FINAL
      // publish step id is the post-approval finalize run — it must terminate
      // the pipeline with a `completed` envelope, not re-emit requires_approval.
      const isPublishFinalize =
        stage === 'publish' && input.workflowStepId === FINAL_PUBLISH_WORKFLOW_STEP_ID;

      const priorStageOutput = ((): Record<string, unknown> | null => {
        if (!productionDoc) return null;
        // The publish-finalize run continues from the publish stage's own
        // output (the publish plan from the first publish run); every other
        // resume continues from the immediately-preceding stage.
        const priorStage: MarketingStage | null =
          isPublishFinalize ? 'publish'
          : stage === 'strategy' ? 'research'
          : stage === 'production' ? 'strategy'
          : stage === 'publish' ? 'production'
          : null;
        if (!priorStage) return null;
        const out = productionDoc.stages[priorStage]?.primary_output;
        return out && typeof out === 'object' && !Array.isArray(out)
          ? (out as Record<string, unknown>)
          : null;
      })();

      // Hermes /v1/runs requires `input` to be a non-empty string (OpenAI-style
      // chat-completions API). Serialize the stage context into a prompt.
      const baseRunLines = [
        `Workflow: ${SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY}`,
        'Action: run',
        `Stage: ${stage}`,
        ...(isPublishFinalize ? ['Publish review: already approved — emit the final completed result.'] : []),
        `Aries run ID: ${ariesRunId}`,
        `Job ID: ${input.jobId ?? ''}`,
        `Tenant ID: ${input.tenantId ?? ''}`,
        `Approval ID: ${input.approvalId ?? ''}`,
        priorStageOutput
          ? `Prior stage output (JSON): ${JSON.stringify(priorStageOutput)}`
          : 'Prior stage output (JSON): {}',
      ];

      // Inject rich per-image prompt context on the production run
      // (approve_post_copy) so the content-generation profile has brand,
      // research, and strategy context when it calls image_generate.
      if (stage === 'production' && productionDoc) {
        const ctx = buildProductionResumeContext({
          doc: productionDoc,
          researchOutput: (productionDoc.stages.research?.primary_output ?? null) as Record<string, unknown> | null,
          strategyOutput: (productionDoc.stages.strategy?.primary_output ?? null) as Record<string, unknown> | null,
          tasteProjection,
        });
        baseRunLines.push('', ctx.contextBlock);
      }

      const runPrompt = baseRunLines.join('\n');
      return {
        input: runPrompt,
        instructions: this.instructions(SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY, stage, input.workflowStepId),
        session_id: this.sessionKey(),
        workflow_key: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
        action: 'run',
        aries_run_id: ariesRunId,
        approval_step: approvalStep,
        approval_id: input.approvalId ?? null,
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
        protocol_version: PROTOCOL_VERSION,
      };
    }

    // Note: a weekly DENIAL (action: resume + approve === false) never reaches
    // submissionPayload — invoke() short-circuits it before any POST. See the
    // early-return in invoke().

    if (action === 'run' && input.doc && usesPerStageProfilePipeline(input.doc)) {
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
      const parsedArgs = input.argsJson ? tryParseJson(input.argsJson) as Record<string, unknown> | null : null;
      const startingStage = parsedArgs && typeof parsedArgs.starting_stage === 'string'
        ? parsedArgs.starting_stage
        : null;
      const isAutoAdvance = parsedArgs?.auto_advance === true;
      const promptLines = [
        `Workflow: ${request.workflow_key}`,
        `Workflow version: ${request.workflow_version}`,
        'Action: run',
        `Aries run ID: ${request.aries_run_id}`,
        `Job ID: ${request.job_id}`,
        `Tenant ID: ${request.tenant_id}`,
        `Callback URL: ${request.callback_url}`,
        `Request (JSON): ${JSON.stringify(request)}`,
      ];
      if (startingStage) {
        promptLines.push(`Starting stage: ${startingStage}`);
      }
      // IMAGE EDIT (image-to-image): when the regenerate context carries an edit
      // instruction, pin the content-generator profile to image_generate's edit
      // endpoint on the existing source image instead of a fresh generation. The
      // tool routes to its edit endpoint deterministically once given a source
      // image (use_edit = bool(source_images)); this contract forces the agent to
      // pass one — mirroring the production stage's "MUST call image_generate"
      // execution contract. Gated upstream by ARIES_IMAGE_EDIT_ENABLED.
      if (input.regenerateCreative?.edit_instruction) {
        const editInstruction = input.regenerateCreative.edit_instruction;
        const sourceBasename = input.regenerateCreative.source_image_basename;
        promptLines.push(
          '',
          'IMAGE EDIT EXECUTION CONTRACT: This run is an image EDIT, not a fresh generation.',
          // JSON-encode EVERY operator-controlled value embedded in the contract
          // (source_creative_id is the URL path param, source_run_id is request
          // body, edit_instruction is free text). All are URL/JSON-decoded and can
          // carry quotes/newlines, so raw interpolation would let a crafted value
          // terminate a line and inject extra "contract" directives.
          `Source creative: source_creative_id=${JSON.stringify(input.regenerateCreative.source_creative_id)} from run ${JSON.stringify(input.regenerateCreative.source_run_id)}.`,
          sourceBasename
            ? `Source image file (in your content-generator image cache): ${JSON.stringify(sourceBasename)}.`
            : 'Source image: resolve it from the prior run identified above.',
          `Call the image_generate tool exactly once with that image as the source image (image-to-image edit endpoint) applying ONLY this change: ${JSON.stringify(editInstruction)}.`,
          'Do NOT generate a new image from scratch — preserve the existing composition, subject, and brand styling, and apply only the requested change. Return the edited image in artifacts.creative_assets[] exactly as a normal production image.',
        );
      }
      const prompt = promptLines.join('\n');
      const promptWithMemory = memoryContextSnapshot && memoryContextSnapshot.length > 0
        ? `${prompt}\n\nMemory context (approved brand/policy findings):\n${JSON.stringify(memoryContextSnapshot)}`
        : prompt;
      return {
        input: promptWithMemory,
        instructions: this.instructions(request.workflow_key, 'research'),
        session_id: this.sessionKey(),
        callback_url: request.callback_url,
        callback_auth: callbackAuth,
        callback_context: {
          workflow_key: request.workflow_key,
          workflow_version: request.workflow_version,
          aries_run_id: request.aries_run_id,
          job_id: request.job_id,
          tenant_id: request.tenant_id,
          ...(isAutoAdvance ? { auto_advance: true } : {}),
          ...(input.regenerateCreative
            ? {
                regenerate_creative: {
                  source_run_id: input.regenerateCreative.source_run_id,
                  source_creative_id: input.regenerateCreative.source_creative_id,
                  ...(input.regenerateCreative.edit_instruction
                    ? { edit_instruction: input.regenerateCreative.edit_instruction }
                    : {}),
                  ...(input.regenerateCreative.source_image_basename
                    ? { source_image_basename: input.regenerateCreative.source_image_basename }
                    : {}),
                },
              }
            : {}),
        },
        idempotency_key: idempotencyKey,
        protocol_version: PROTOCOL_VERSION,
      };
    }

    const idempotencyKey = generateIdempotencyKey(ariesRunId, workflowKey, input.tenantId ?? '');
    const basePrompt = this.prompt(action, ariesRunId, input, workflowKey);
    const promptWithMemory = memoryContextSnapshot && memoryContextSnapshot.length > 0
      ? `${basePrompt}\n\nMemory context (approved brand/policy findings):\n${JSON.stringify(memoryContextSnapshot)}`
      : basePrompt;
    const parsedRunArgs = action === 'run' && input.argsJson
      ? tryParseJson(input.argsJson) as Record<string, unknown> | null
      : null;
    const runIsAutoAdvance = parsedRunArgs?.auto_advance === true;
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
        ...(runIsAutoAdvance ? { auto_advance: true } : {}),
      },
      idempotency_key: idempotencyKey,
      protocol_version: PROTOCOL_VERSION,
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
    input: { doc?: SocialContentJobRuntimeDocument; workflowKey?: string },
  ): string {
    if (action === 'resume' && input.workflowKey && input.workflowKey.trim().length > 0) {
      return input.workflowKey.trim();
    }
    return action === 'run' && input.doc && usesPerStageProfilePipeline(input.doc)
      ? SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY
      : BRAND_CAMPAIGN_WORKFLOW_KEY;
  }

  private async pollRunUntilTerminal(
    runId: string,
    ariesRunId: string,
    profile?: HermesTargetProfile,
  ): Promise<MarketingExecutionResult> {
    const timeoutMs = readEnvInt(this.env, 'HERMES_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);
    const intervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      readEnvInt(this.env, 'HERMES_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    );
    const deadline = Date.now() + timeoutMs;
    // Resolve the gateway this run lives on. Undefined profile → default
    // gateway (submitRawRun and any legacy single-gateway caller).
    const pollGatewayUrl = profile ? this.gatewayUrlForProfile(profile) : this.gatewayUrl();
    const pollAuthHeader = profile ? this.authHeaderForProfile(profile) : this.authHeader();

    const failRun = (code: string, message: string, detail?: Record<string, unknown>): MarketingExecutionResult => {
      markSubmissionFailed(ariesRunId, code, message);
      return gatewayErrorResult(code, message, detail);
    };

    while (Date.now() <= deadline) {
      let pollResponse: Response;
      try {
        pollResponse = await this.fetchImpl(
          `${pollGatewayUrl}/v1/runs/${encodeURIComponent(runId)}`,
          { method: 'GET', headers: { authorization: pollAuthHeader } },
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
    // Hermes may emit approval.stage as:
    //   (a) a canonical NEXT stage name ("strategy", "production", "publish", ...),
    //   (b) a transition descriptor ("research_to_strategy", "strategy_to_production"),
    //   (c) a bare COMPLETING-stage name ("research") — v0.1.3.43 convention.
    // Aries' validateApprovalTransition expects (a). Normalize at this single
    // chokepoint so the downstream bridge can be a pure passthrough.
    //
    // Prior bug: this pre-filter used to silently default any non-canonical
    // value (including "research_to_strategy" and "research") to "production",
    // which the downstream bridge then mapped to "publish" via its own
    // completing→next map. End result: validator received "publish" when run
    // was at research stage, rejected as approval_stage_mismatch. Every
    // tenant-15 brand_campaign in May 2026 hit this. The v0.1.3.43 and
    // v0.1.3.46 fixes patched the wrong layer (the bridge); the actual
    // mangling was here.
    const TRANSITION_STAGE_RE_INPUT = /^[a-z][a-z0-9]*_to_([a-z][a-z0-9]*)$/;
    const COMPLETING_TO_NEXT_INPUT: Record<string, string> = {
      research: 'strategy',
      strategy: 'production',
      production: 'publish',
    };
    const approvalStageParsed: string | undefined = (() => {
      if (typeof approvalStage !== 'string') return approvalStage;
      const transitionMatch = TRANSITION_STAGE_RE_INPUT.exec(approvalStage);
      if (transitionMatch) return transitionMatch[1];
      // If it's a known completing-stage name AND not already a valid
      // next-stage value, map completing → next. The overlap ("strategy" is
      // both a valid next-stage from research AND a completing-stage name
      // for the strategy run) is resolved by preferring next-stage semantics
      // since the validator checks the next stage; the bridge will see what
      // run.stage requires for the current transition.
      return approvalStage;
    })();
    const normalizedApprovalStage = (
      approvalStageParsed === 'plan'
      || approvalStageParsed === 'creative'
      || approvalStageParsed === 'video'
      || approvalStageParsed === 'publish'
      || approvalStageParsed === 'strategy'
      || approvalStageParsed === 'production'
    )
      ? approvalStageParsed
      : (typeof approvalStageParsed === 'string' && COMPLETING_TO_NEXT_INPUT[approvalStageParsed])
        ? COMPLETING_TO_NEXT_INPUT[approvalStageParsed]
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
            stage: normalizedApprovalStage as SocialContentApprovalStage,
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

  private instructions(
    workflowKey: string,
    stage?: MarketingStage,
    workflowStepId?: string | null,
  ): string {
    if (workflowKey === SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY) {
      return buildHermesStageInstructions(workflowKey, stage ?? 'research', workflowStepId);
    }
    return buildHermesInstructions(workflowKey);
  }
}
