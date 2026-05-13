import {
  resumeOpenClawLobsterWorkflow,
  runOpenClawLobsterWorkflow,
} from '../../openclaw/gateway-client';
import type {
  MarketingPipelineResumeInput,
  MarketingPipelineRunInput,
} from '../execution-port';

const MARKETING_PIPELINE_FILE = 'marketing-pipeline.lobster';

// Provider-specific defaults owned by the legacy adapter. These are not
// surfaced on the MarketingExecutionPort interface so the Hermes path never
// reads OpenClaw env vars.
const LEGACY_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const LEGACY_DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export type LegacyMarketingPortRuntimePaths = {
  gatewayCwd: string;
  localCwd: string;
};

type LegacyMarketingExecutionResult = {
  kind: 'completed';
  provider: 'legacy-openclaw';
  envelope: unknown;
};

type LegacyEnv = Partial<Record<string, string | undefined>>;

function legacyPositiveIntEnv(env: LegacyEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Marketing execution port backed by the existing OpenClaw/Lobster gateway.
 * Pure delegation — preserves the historical run/resume call shape so this
 * adapter ships zero behavior change versus calling the gateway directly.
 *
 * All provider-specific knobs (timeouts, stdout caps, session key) are
 * resolved from OpenClaw env vars here so the orchestrator's Hermes-default
 * path never reads them.
 */
export class LegacyOpenClawMarketingPort {
  readonly name = 'legacy-openclaw' as const;

  constructor(
    private readonly resolvePaths: () => LegacyMarketingPortRuntimePaths,
    private readonly env: LegacyEnv = process.env,
  ) {}

  private resolveTimeoutMs(): number {
    return legacyPositiveIntEnv(
      this.env,
      'OPENCLAW_MARKETING_WORKFLOW_TIMEOUT_MS',
      LEGACY_DEFAULT_TIMEOUT_MS,
    );
  }

  private resolveMaxStdoutBytes(): number {
    return legacyPositiveIntEnv(
      this.env,
      'OPENCLAW_MARKETING_WORKFLOW_MAX_STDOUT_BYTES',
      LEGACY_DEFAULT_MAX_STDOUT_BYTES,
    );
  }

  resolveSessionKey(): string {
    return this.env.OPENCLAW_SESSION_KEY?.trim() || 'main';
  }

  async runPipeline(input: MarketingPipelineRunInput): Promise<LegacyMarketingExecutionResult> {
    const { gatewayCwd, localCwd } = this.resolvePaths();
    const timeoutMs = input.timeoutMs ?? this.resolveTimeoutMs();
    const maxStdoutBytes = input.maxStdoutBytes ?? this.resolveMaxStdoutBytes();
    // Inject agent_id from the legacy-specific OPENCLAW_SESSION_KEY env var so
    // the orchestrator never reads OpenClaw env vars on the Hermes-default path.
    const argsJson = this.injectAgentId(input.argsJson);
    const envelope = await runOpenClawLobsterWorkflow({
      pipeline: MARKETING_PIPELINE_FILE,
      cwd: gatewayCwd,
      localCwd,
      argsJson,
      timeoutMs,
      maxStdoutBytes,
      allowLocalFallback: false,
    });
    return { kind: 'completed', provider: this.name, envelope };
  }

  private injectAgentId(argsJson: string): string {
    try {
      const parsed = JSON.parse(argsJson) as Record<string, unknown>;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        parsed.agent_id = this.resolveSessionKey();
        return JSON.stringify(parsed);
      }
    } catch {
      // Fall through — return original if not parseable
    }
    return argsJson;
  }

  async resumePipeline(input: MarketingPipelineResumeInput): Promise<LegacyMarketingExecutionResult> {
    const { gatewayCwd, localCwd } = this.resolvePaths();
    const timeoutMs = input.timeoutMs ?? this.resolveTimeoutMs();
    const maxStdoutBytes = input.maxStdoutBytes ?? this.resolveMaxStdoutBytes();
    const envelope = await resumeOpenClawLobsterWorkflow({
      token: input.resumeToken,
      approve: input.approve,
      cwd: gatewayCwd,
      localCwd,
      timeoutMs,
      maxStdoutBytes,
      allowLocalFallback: false,
    });
    return { kind: 'completed', provider: this.name, envelope };
  }
}
