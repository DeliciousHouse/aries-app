import type { LobsterEnvelope } from '../../openclaw/gateway-client';
import type {
  MarketingExecutionPort,
  MarketingPipelineResumeInput,
  MarketingPipelineRunInput,
} from '../execution-port';

const NOT_IMPLEMENTED_MESSAGE =
  'Hermes marketing execution port is selected but Hermes-side marketing pipeline parity is not implemented yet. Set ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw to keep the current runtime.';

function notImplementedEnvelope(action: 'run' | 'resume', detail: Record<string, unknown>): LobsterEnvelope {
  return {
    ok: false,
    status: 'not_implemented',
    provider: 'hermes',
    action,
    code: 'hermes_marketing_pipeline_not_implemented',
    message: NOT_IMPLEMENTED_MESSAGE,
    detail,
  };
}

/**
 * Marketing execution port backed by the Hermes gateway.
 *
 * Phase 9 wires the port boundary so the orchestrator stops calling the
 * OpenClaw client directly. The actual Hermes-side marketing pipeline
 * implementation (research / strategy / production / publish stages with
 * approval checkpoints) lives in a later phase. Until that exists, this port
 * returns an honest `not_implemented` envelope rather than silently falling
 * back to the legacy provider.
 */
export class HermesMarketingPort implements MarketingExecutionPort {
  readonly name = 'hermes' as const;

  async runPipeline(input: MarketingPipelineRunInput): Promise<LobsterEnvelope> {
    return notImplementedEnvelope('run', { jobId: input.jobId });
  }

  async resumePipeline(input: MarketingPipelineResumeInput): Promise<LobsterEnvelope> {
    return notImplementedEnvelope('resume', {
      resumeTokenFingerprint: hashToken(input.resumeToken),
      approve: input.approve,
    });
  }
}

function hashToken(token: string): string {
  // Truncated, non-reversible identifier so logs/envelopes can correlate
  // resume attempts without leaking the full token. Order-preserving for
  // identical inputs in the same process; not a cryptographic hash.
  if (!token) return '';
  let h = 0;
  for (let i = 0; i < token.length; i += 1) {
    h = (h * 31 + token.charCodeAt(i)) | 0;
  }
  return `tok_${(h >>> 0).toString(16)}`;
}
