import {
  getMarketingExecutionPort,
  type MarketingExecutionPort,
  type MarketingExecutionPortEnv,
  type RegenerateCreativeContext,
} from './execution-port';
import { resolveMarketingPipelineRuntimePaths } from './orchestrator';
import {
  loadMarketingJobRuntime,
  type MarketingJobRuntimeDocument,
  type MarketingStage,
} from './runtime-state';

const REGENERATE_TIMEOUT_MS = 15 * 60 * 1000;
const REGENERATE_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export type RegenerateCreativeInput = {
  jobId: string;
  creativeId: string;
  tenantId: string;
  sourceRunId?: string | null;
  port?: MarketingExecutionPort;
  env?: MarketingExecutionPortEnv;
};

export type RegenerateCreativeResult =
  | {
      kind: 'submitted';
      ariesRunId: string;
      hermesRunId: string | null;
      sourceRunId: string;
      sourceCreativeId: string;
      jobId: string;
      tenantId: string;
    }
  | { kind: 'job_not_found' }
  | { kind: 'tenant_mismatch' }
  | { kind: 'invalid_input'; code: 'missing_creative_id' | 'missing_source_run_id'; message: string }
  | { kind: 'failed'; code: string; message: string };

function nonEmpty(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function inferSourceRunIdFromDoc(doc: MarketingJobRuntimeDocument): string {
  const order: MarketingStage[] = ['publish', 'production', 'strategy', 'research'];
  for (const stage of order) {
    const runId = nonEmpty(doc.stages?.[stage]?.run_id);
    if (runId) return runId;
  }
  return '';
}

function defaultPortFactory(env?: MarketingExecutionPortEnv): MarketingExecutionPort {
  return getMarketingExecutionPort(() => {
    const { gatewayCwd, localCwd } = resolveMarketingPipelineRuntimePaths();
    return { gatewayCwd, localCwd };
  }, env);
}

export async function regenerateCreativeAsNewRun(
  input: RegenerateCreativeInput,
): Promise<RegenerateCreativeResult> {
  const creativeId = nonEmpty(input.creativeId);
  if (!creativeId) {
    return {
      kind: 'invalid_input',
      code: 'missing_creative_id',
      message: 'creativeId is required.',
    };
  }

  const doc = await loadMarketingJobRuntime(input.jobId);
  if (!doc) {
    return { kind: 'job_not_found' };
  }
  if (doc.tenant_id !== input.tenantId) {
    return { kind: 'tenant_mismatch' };
  }

  const sourceRunId = nonEmpty(input.sourceRunId) || inferSourceRunIdFromDoc(doc);
  if (!sourceRunId) {
    return {
      kind: 'invalid_input',
      code: 'missing_source_run_id',
      message: 'source_run_id is required to regenerate a creative.',
    };
  }

  const regenerateCreative: RegenerateCreativeContext = {
    source_run_id: sourceRunId,
    source_creative_id: creativeId,
  };

  const port = input.port ?? defaultPortFactory(input.env);

  const result = await port.runPipeline({
    jobId: input.jobId,
    doc,
    argsJson: JSON.stringify({
      job_id: input.jobId,
      regenerate_creative: regenerateCreative,
    }),
    timeoutMs: REGENERATE_TIMEOUT_MS,
    maxStdoutBytes: REGENERATE_MAX_STDOUT_BYTES,
    regenerateCreative,
  });

  if (result.kind === 'submitted') {
    if (result.ariesRunId === sourceRunId) {
      return {
        kind: 'failed',
        code: 'regenerate_run_collision',
        message: 'Regenerate produced the same aries_run_id as the source run.',
      };
    }
    return {
      kind: 'submitted',
      ariesRunId: result.ariesRunId,
      hermesRunId: result.hermesRunId ?? null,
      sourceRunId,
      sourceCreativeId: creativeId,
      jobId: input.jobId,
      tenantId: input.tenantId,
    };
  }

  const error = result.output.error;
  return {
    kind: 'failed',
    code: error?.code ?? 'hermes_regenerate_run_failed',
    message: error?.message ?? 'Hermes did not return a submitted regenerate run.',
  };
}
