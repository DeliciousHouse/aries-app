import { HermesMarketingPort } from './ports/hermes';
import type { SocialContentJobRuntimeDocument, MarketingStage, MarketingStageArtifact } from './runtime-state';
import type { SocialContentApprovalStep } from '@/backend/social-content/types';

/**
 * Hermes-native execution contract for the marketing and social-content
 * workflows. Fail-fast configuration validation for the orchestrator lives in
 * backend/marketing/provider-guard.ts.
 */
export type MarketingExecutionPortName = 'hermes';

export type SocialContentStage = MarketingStage;
export type SocialContentApprovalStage =
  | 'plan'
  | 'creative'
  | 'video'
  | 'publish'
  | 'strategy'
  | 'production';
export type SocialContentArtifact = MarketingStageArtifact;

export type HermesWorkflowOutput = {
  ok: boolean;
  status: 'running' | 'requires_approval' | 'completed' | 'failed' | 'cancelled';
  workflowKey: string;
  workflowVersion?: string;
  runId?: string;
  stage?: SocialContentStage;
  output?: Record<string, unknown> | Record<string, unknown>[];
  artifacts?: SocialContentArtifact[];
  approval?: {
    stage: SocialContentApprovalStage;
    workflowStepId: string;
    prompt: string;
    approvalStep?: SocialContentApprovalStep;
    resumeToken?: string;
  };
  error?: {
    code?: string;
    message: string;
    retryable?: boolean;
  };
};

export type RegenerateCreativeContext = {
  source_run_id: string;
  source_creative_id: string;
};

export type MarketingPipelineRunInput = {
  jobId: string;
  doc: SocialContentJobRuntimeDocument;
  argsJson: string;
  /**
   * Optional timeout override. The Hermes port does not honor this field —
   * Hermes timeouts are controlled by HERMES_RUN_TIMEOUT_MS at the port level.
   */
  timeoutMs?: number;
  /**
   * Optional stdout cap override. The Hermes port does not use this field.
   */
  maxStdoutBytes?: number;
  /**
   * When set, scopes the new aries_run to a single creative regeneration
   * instead of a full pipeline. Hermes uses this to redo just the targeted
   * creative; the original aries_run remains untouched (no callback
   * stage-regression). Owned by T14 (regenerate creative).
   */
  regenerateCreative?: RegenerateCreativeContext;
};

export type MarketingPipelineResumeInput = {
  resumeToken: string;
  approve: boolean;
  /** Optional timeout override; see MarketingPipelineRunInput.timeoutMs. */
  timeoutMs?: number;
  /** Optional stdout cap override; see MarketingPipelineRunInput.maxStdoutBytes. */
  maxStdoutBytes?: number;
  tenantId?: string | null;
  jobId?: string | null;
  approvalId?: string | null;
  stage?: MarketingStage | null;
  workflowStepId?: string | null;
  approvalStep?: SocialContentApprovalStep | null;
  workflowKey?: string | null;
};

export type MarketingExecutionResult =
  | { kind: 'completed'; provider: 'hermes'; output: HermesWorkflowOutput }
  | { kind: 'submitted'; provider: 'hermes'; ariesRunId: string; hermesRunId?: string };

export type MarketingPipelineNextStageInput = {
  jobId: string;
  tenantId: string;
  doc: SocialContentJobRuntimeDocument;
  stage: MarketingStage; // the NEXT stage to submit (strategy | production | publish)
};

export type SubmitRawRunInput = {
  ariesRunId: string;
  tenantId: string;
  workflowKey: string;
  stage: MarketingStage;
  payload: Record<string, unknown>;
  callbackToken: string;
};

export type SubmitRawRunResult = {
  ariesRunId: string;
  hermesRunId: string;
};

export interface MarketingExecutionPort {
  readonly name: MarketingExecutionPortName;
  runPipeline(input: MarketingPipelineRunInput): Promise<MarketingExecutionResult>;
  resumePipeline(input: MarketingPipelineResumeInput): Promise<MarketingExecutionResult>;
  submitNextStage(input: MarketingPipelineNextStageInput): Promise<MarketingExecutionResult>;
  /** Returns the callback URL this port expects Hermes to POST results to. */
  getCallbackUrl(): string;
  /** Returns the Hermes session key (used as `session_id` in gateway payloads). */
  getSessionKey(): string;
  /**
   * Dispatches a pre-built payload to the Hermes gateway and kicks off the
   * poll bridge. Throws on gateway/config errors — caller is responsible for
   * managing execution run record lifecycle around this call.
   */
  submitRawRun(input: SubmitRawRunInput): Promise<SubmitRawRunResult>;
}

export type MarketingExecutionPortEnv = Partial<Record<string, string | undefined>>;

export const DEFAULT_MARKETING_EXECUTION_PORT: MarketingExecutionPortName = 'hermes';

/**
 * Resolve the configured marketing execution port name.
 *
 * Marketing execution is Hermes-only — any value resolves to Hermes.
 */
export function resolveMarketingExecutionPortName(
  _env: MarketingExecutionPortEnv = process.env,
): MarketingExecutionPortName {
  return DEFAULT_MARKETING_EXECUTION_PORT;
}

export function getMarketingExecutionPort(
  env: MarketingExecutionPortEnv = process.env,
): MarketingExecutionPort {
  return new HermesMarketingPort(env);
}
