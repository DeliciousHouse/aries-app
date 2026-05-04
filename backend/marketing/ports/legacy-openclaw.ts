import {
  resumeOpenClawLobsterWorkflow,
  runOpenClawLobsterWorkflow,
} from '../../openclaw/gateway-client';
import type {
  MarketingExecutionResult,
  MarketingExecutionPort,
  MarketingPipelineResumeInput,
  MarketingPipelineRunInput,
} from '../execution-port';

const MARKETING_PIPELINE_FILE = 'marketing-pipeline.lobster';

export type LegacyMarketingPortRuntimePaths = {
  gatewayCwd: string;
  localCwd: string;
};

/**
 * Marketing execution port backed by the existing OpenClaw/Lobster gateway.
 * Pure delegation — preserves the historical run/resume call shape so this
 * adapter ships zero behavior change versus calling the gateway directly.
 */
export class LegacyOpenClawMarketingPort implements MarketingExecutionPort {
  readonly name = 'legacy-openclaw' as const;

  constructor(
    private readonly resolvePaths: () => LegacyMarketingPortRuntimePaths,
  ) {}

  async runPipeline(input: MarketingPipelineRunInput): Promise<MarketingExecutionResult> {
    const { gatewayCwd, localCwd } = this.resolvePaths();
    const envelope = await runOpenClawLobsterWorkflow({
      pipeline: MARKETING_PIPELINE_FILE,
      cwd: gatewayCwd,
      localCwd,
      argsJson: input.argsJson,
      timeoutMs: input.timeoutMs,
      maxStdoutBytes: input.maxStdoutBytes,
      allowLocalFallback: false,
    });
    return { kind: 'completed', provider: this.name, envelope };
  }

  async resumePipeline(input: MarketingPipelineResumeInput): Promise<MarketingExecutionResult> {
    const { gatewayCwd, localCwd } = this.resolvePaths();
    const envelope = await resumeOpenClawLobsterWorkflow({
      token: input.resumeToken,
      approve: input.approve,
      cwd: gatewayCwd,
      localCwd,
      timeoutMs: input.timeoutMs,
      maxStdoutBytes: input.maxStdoutBytes,
      allowLocalFallback: false,
    });
    return { kind: 'completed', provider: this.name, envelope };
  }
}
