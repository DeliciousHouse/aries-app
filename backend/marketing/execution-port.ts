import type { LobsterEnvelope } from '../openclaw/gateway-client';

import { HermesMarketingPort } from './ports/hermes';
import { LegacyOpenClawMarketingPort, type LegacyMarketingPortRuntimePaths } from './ports/legacy-openclaw';
import type { MarketingJobRuntimeDocument } from './runtime-state';

/**
 * Provider-neutral execution port for marketing pipeline run/resume.
 *
 * Both ports must return a `LobsterEnvelope`-shaped result so the orchestrator
 * keeps a single downstream code path while the migration to Hermes is in
 * progress. The Hermes port is allowed to return an envelope with
 * `ok: false, status: 'not_implemented'` — the orchestrator already handles
 * non-ok envelopes via the existing failure surface. What the Hermes port may
 * NOT do is silently fall back to the legacy provider; that would defeat the
 * provider-selection invariant the rest of the migration depends on.
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
};

export interface MarketingExecutionPort {
  readonly name: MarketingExecutionPortName;
  runPipeline(input: MarketingPipelineRunInput): Promise<LobsterEnvelope>;
  resumePipeline(input: MarketingPipelineResumeInput): Promise<LobsterEnvelope>;
}

export type MarketingExecutionPortEnv = Partial<Record<string, string | undefined>>;

export const DEFAULT_MARKETING_EXECUTION_PORT: MarketingExecutionPortName = 'legacy-openclaw';

/**
 * Resolve the configured marketing execution port name.
 *
 * Marketing migration is intentionally opt-in — the route-level
 * `ARIES_EXECUTION_PROVIDER` flag does NOT switch marketing to Hermes by
 * itself. Only `ARIES_MARKETING_EXECUTION_PROVIDER=hermes` enables the Hermes
 * marketing port. This keeps approval-bearing campaigns on the proven
 * legacy path until Hermes-side marketing parity exists.
 */
export function resolveMarketingExecutionPortName(
  env: MarketingExecutionPortEnv = process.env,
): MarketingExecutionPortName {
  const value = typeof env.ARIES_MARKETING_EXECUTION_PROVIDER === 'string'
    ? env.ARIES_MARKETING_EXECUTION_PROVIDER.trim().toLowerCase()
    : '';
  if (value === 'hermes') return 'hermes';
  return DEFAULT_MARKETING_EXECUTION_PORT;
}

export function getMarketingExecutionPort(
  resolveLegacyPaths: () => LegacyMarketingPortRuntimePaths,
  env: MarketingExecutionPortEnv = process.env,
): MarketingExecutionPort {
  const name = resolveMarketingExecutionPortName(env);
  if (name === 'hermes') return new HermesMarketingPort();
  return new LegacyOpenClawMarketingPort(resolveLegacyPaths);
}
