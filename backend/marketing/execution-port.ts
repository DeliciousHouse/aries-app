import type { LobsterEnvelope } from '../openclaw/gateway-client';

import { HermesMarketingPort } from './ports/hermes';
import { LegacyOpenClawMarketingPort, type LegacyMarketingPortRuntimePaths } from './ports/legacy-openclaw';
import type { MarketingJobRuntimeDocument, MarketingStage } from './runtime-state';

/**
 * Provider-neutral execution port for marketing pipeline run/resume.
 *
 * Legacy OpenClaw returns completed Lobster envelopes synchronously. Hermes
 * submits work and returns an Aries/Hermes run correlation pair; callbacks
 * later advance the runtime document.
 */
export type MarketingExecutionPortName = 'legacy-openclaw' | 'hermes';

export type MarketingPipelineRunInput = {
  jobId: string;
  doc: MarketingJobRuntimeDocument;
  argsJson: string;
  timeoutMs: number;
  maxStdoutBytes: number;
};

export type MarketingPipelineResumeInput = {
  resumeToken: string;
  approve: boolean;
  timeoutMs: number;
  maxStdoutBytes: number;
  tenantId?: string | null;
  jobId?: string | null;
  approvalId?: string | null;
  stage?: MarketingStage | null;
  workflowStepId?: string | null;
};

export type MarketingExecutionResult =
  | { kind: 'completed'; provider: MarketingExecutionPortName; envelope: LobsterEnvelope }
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
 * Hermes is the default marketing execution provider. Operators can still opt
 * into the legacy OpenClaw/Lobster runtime with
 * `ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw`.
 */
export function resolveMarketingExecutionPortName(
  env: MarketingExecutionPortEnv = process.env,
): MarketingExecutionPortName {
  const value = typeof env.ARIES_MARKETING_EXECUTION_PROVIDER === 'string'
    ? env.ARIES_MARKETING_EXECUTION_PROVIDER.trim().toLowerCase()
    : '';
  if (value === 'hermes' || value === '') return 'hermes';
  if (value === 'legacy-openclaw' || value === 'openclaw') return 'legacy-openclaw';
  return DEFAULT_MARKETING_EXECUTION_PORT;
}

export function getMarketingExecutionPort(
  resolveLegacyPaths: () => LegacyMarketingPortRuntimePaths,
  env: MarketingExecutionPortEnv = process.env,
): MarketingExecutionPort {
  const name = resolveMarketingExecutionPortName(env);
  if (name === 'hermes') return new HermesMarketingPort(env);
  return new LegacyOpenClawMarketingPort(resolveLegacyPaths);
}
