import { HermesMarketingPort } from './ports/hermes';
import type { MarketingJobRuntimeDocument, MarketingStage, MarketingStageArtifact } from './runtime-state';
import type { SocialContentApprovalStep } from '@/backend/social-content/types';

/**
 * Hermes-native execution contract for the marketing and social-content
 * workflows. This module is kept free of legacy OpenClaw references so it can
 * be safely imported by social-content routes without pulling in deprecated
 * dependencies. Provider selection and fail-fast validation for the broader
 * orchestrator live in backend/marketing/provider-guard.ts.
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
  doc: MarketingJobRuntimeDocument;
  argsJson: string;
  /**
   * Optional timeout override. When omitted, each port resolves its own
   * provider-appropriate default (e.g. HERMES_RUN_TIMEOUT_MS for Hermes,
   * OPENCLAW_MARKETING_WORKFLOW_TIMEOUT_MS for the legacy OpenClaw adapter).
   */
  timeoutMs?: number;
  /**
   * Optional stdout cap override. When omitted, each port resolves its own
   * provider-appropriate default. The Hermes port does not use this field.
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

export interface MarketingExecutionPort {
  readonly name: MarketingExecutionPortName;
  runPipeline(input: MarketingPipelineRunInput): Promise<MarketingExecutionResult>;
  resumePipeline(input: MarketingPipelineResumeInput): Promise<MarketingExecutionResult>;
}

export type MarketingExecutionPortEnv = Partial<Record<string, string | undefined>>;

export const DEFAULT_MARKETING_EXECUTION_PORT: MarketingExecutionPortName = 'hermes';

/**
 * Resolve the configured marketing execution port name.
 *
 * Social-content execution is Hermes-only. Unknown/legacy values resolve to
 * Hermes for backwards-safe configuration handling.
 */
export function resolveMarketingExecutionPortName(
  env: MarketingExecutionPortEnv = process.env,
): MarketingExecutionPortName {
  const value = typeof env.ARIES_MARKETING_EXECUTION_PROVIDER === 'string'
    ? env.ARIES_MARKETING_EXECUTION_PROVIDER.trim().toLowerCase()
    : '';
  if (value === 'hermes' || value === '') return 'hermes';
  return DEFAULT_MARKETING_EXECUTION_PORT;
}

export function getMarketingExecutionPort(
  _resolveLegacyPaths: () => unknown,
  env: MarketingExecutionPortEnv = process.env,
): MarketingExecutionPort {
  resolveMarketingExecutionPortName(env);
  return new HermesMarketingPort(env);
}
