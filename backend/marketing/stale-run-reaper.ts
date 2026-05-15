import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  MarketingJobRuntimeDocument,
  MarketingJobState,
  MarketingJobStatus,
  MarketingStage,
  MarketingStageError,
} from './runtime-state';

const MARKETING_JOBS_SUBDIR = path.join('generated', 'draft', 'marketing-jobs');

const KNOWN_SCHEMA_NAMES = new Set([
  'marketing_job_state_schema',
  'job_runtime_state_schema',
]);

const STALE_REAPER_FAILURE_REASON = 'marketing_job_stalled';
const STALE_REAPER_ERROR_MESSAGE =
  'Marketing job stalled without progress and was failed by the stale-run reaper.';

const DEFAULT_MARKETING_WORKFLOW_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_STALE_THRESHOLD_MS = DEFAULT_MARKETING_WORKFLOW_TIMEOUT_MS * 2;
const DEFAULT_STAGE_THRESHOLD_MS: Readonly<Record<MarketingStage, number>> = {
  research: 10 * 60 * 1000,
  strategy: 5 * 60 * 1000,
  production: 90 * 60 * 1000,
  publish: 30 * 60 * 1000,
};
const STAGE_THRESHOLD_ENV_BY_STAGE: Readonly<Record<MarketingStage, string>> = {
  research: 'STALE_RUN_REAPER_RESEARCH_THRESHOLD_MS',
  strategy: 'STALE_RUN_REAPER_STRATEGY_THRESHOLD_MS',
  production: 'STALE_RUN_REAPER_PRODUCTION_THRESHOLD_MS',
  publish: 'STALE_RUN_REAPER_PUBLISH_THRESHOLD_MS',
};

const IN_FLIGHT_STATES: ReadonlySet<MarketingJobState> = new Set([
  'queued',
  'running',
  'approval_required',
]);

const IN_FLIGHT_STATUSES: ReadonlySet<MarketingJobStatus> = new Set([
  'pending',
  'running',
  'awaiting_approval',
]);

export type StaleRunReaperOptions = {
  dataRoot: string;
  dryRun: boolean;
  now?: () => Date;
  thresholdMs?: number;
};

export type StaleRunCandidate = {
  jobId: string;
  tenantId: string;
  state: MarketingJobState;
  status: MarketingJobStatus;
  stage: MarketingStage;
  progressAt: string;
  silentMs: number;
  thresholdMs: number;
  filePath: string;
  mutated: boolean;
};

export type StaleRunReaperReport = {
  scanned: number;
  candidates: StaleRunCandidate[];
  mutated: number;
  skipped: number;
  errors: number;
  thresholdMs: number;
  thresholdsByStage: Record<MarketingStage, number>;
  dryRun: boolean;
};

function parsePositiveInt(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function staleRunReaperGlobalThresholdOverrideMs(): number | null {
  return parsePositiveInt(process.env.STALE_RUN_REAPER_THRESHOLD_MS);
}

export function staleRunReaperThresholdMs(stage?: MarketingStage): number {
  const globalOverride = staleRunReaperGlobalThresholdOverrideMs();
  if (globalOverride !== null) return globalOverride;
  if (stage) {
    return (
      parsePositiveInt(process.env[STAGE_THRESHOLD_ENV_BY_STAGE[stage]]) ??
      DEFAULT_STAGE_THRESHOLD_MS[stage]
    );
  }
  const raw = process.env.STALE_RUN_REAPER_THRESHOLD_MS?.trim();
  if (!raw) return DEFAULT_STALE_THRESHOLD_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STALE_THRESHOLD_MS;
  return parsed;
}

export function staleRunReaperThresholdsByStage(): Record<MarketingStage, number> {
  return {
    research: staleRunReaperThresholdMs('research'),
    strategy: staleRunReaperThresholdMs('strategy'),
    production: staleRunReaperThresholdMs('production'),
    publish: staleRunReaperThresholdMs('publish'),
  };
}

function isKnownSchema(value: unknown): boolean {
  return typeof value === 'string' && KNOWN_SCHEMA_NAMES.has(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asMarketingState(value: unknown): MarketingJobState | null {
  const s = asString(value);
  if (
    s === 'queued' ||
    s === 'running' ||
    s === 'approval_required' ||
    s === 'completed' ||
    s === 'failed' ||
    s === 'needs_connection'
  ) {
    return s;
  }
  return null;
}

function asMarketingStatus(value: unknown): MarketingJobStatus | null {
  const s = asString(value);
  if (
    s === 'pending' ||
    s === 'running' ||
    s === 'awaiting_approval' ||
    s === 'completed' ||
    s === 'failed' ||
    s === 'needs_connection' ||
    s === 'failed_stale'
  ) {
    return s;
  }
  return null;
}

function asMarketingStage(value: unknown): MarketingStage | null {
  const s = asString(value);
  if (s === 'research' || s === 'strategy' || s === 'production' || s === 'publish') {
    return s;
  }
  return null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pushTimestampMs(values: number[], value: unknown): void {
  const parsed = parseTimestampMs(value);
  if (parsed !== null) values.push(parsed);
}

function latestProgressTimestamp(parsed: Record<string, unknown>, stage: MarketingStage): number | null {
  const timestamps: number[] = [];
  pushTimestampMs(timestamps, parsed.updated_at);

  const stages = parsed.stages;
  const stageRecord =
    stages && typeof stages === 'object' && !Array.isArray(stages)
      ? ((stages as Record<string, unknown>)[stage] as Record<string, unknown> | undefined)
      : undefined;
  if (stageRecord && typeof stageRecord === 'object' && !Array.isArray(stageRecord)) {
    pushTimestampMs(timestamps, stageRecord.started_at);
    pushTimestampMs(timestamps, stageRecord.completed_at);
    pushTimestampMs(timestamps, stageRecord.failed_at);
  }

  const approvals = parsed.approvals;
  const currentApproval =
    approvals && typeof approvals === 'object' && !Array.isArray(approvals)
      ? ((approvals as Record<string, unknown>).current as Record<string, unknown> | null | undefined)
      : null;
  if (
    currentApproval &&
    typeof currentApproval === 'object' &&
    !Array.isArray(currentApproval) &&
    asMarketingStage(currentApproval.stage) === stage
  ) {
    pushTimestampMs(timestamps, currentApproval.requested_at);
  }

  const history = Array.isArray(parsed.history) ? parsed.history : [];
  for (const entry of history) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (asMarketingStage((entry as Record<string, unknown>).stage) !== stage) continue;
    pushTimestampMs(timestamps, (entry as Record<string, unknown>).at);
  }

  if (timestamps.length === 0) return null;
  return Math.max(...timestamps);
}

function isTerminalDoc(state: MarketingJobState, status: MarketingJobStatus): boolean {
  if (state === 'completed' || state === 'failed' || state === 'needs_connection') return true;
  if (status === 'completed' || status === 'failed' || status === 'needs_connection') return true;
  if (status === 'failed_stale') return true;
  return false;
}

function isInFlight(state: MarketingJobState, status: MarketingJobStatus): boolean {
  return IN_FLIGHT_STATES.has(state) || IN_FLIGHT_STATUSES.has(status);
}

function alreadyReaped(doc: MarketingJobRuntimeDocument): boolean {
  if (doc.status === 'failed_stale') return true;
  if (typeof doc.failure_reason === 'string' && doc.failure_reason === STALE_REAPER_FAILURE_REASON) {
    return true;
  }
  if (doc.last_error && doc.last_error.code === STALE_REAPER_FAILURE_REASON) return true;
  return false;
}

function logInfo(message: string, fields?: Record<string, unknown>): void {
  if (fields) {
    process.stdout.write(`[stale-run-reaper] ${message} ${JSON.stringify(fields)}\n`);
    return;
  }
  process.stdout.write(`[stale-run-reaper] ${message}\n`);
}

function logWarn(message: string, fields?: Record<string, unknown>): void {
  if (fields) {
    process.stderr.write(`[stale-run-reaper] WARN ${message} ${JSON.stringify(fields)}\n`);
    return;
  }
  process.stderr.write(`[stale-run-reaper] WARN ${message}\n`);
}

function applyStaleMarker(
  doc: MarketingJobRuntimeDocument,
  candidate: StaleRunCandidate,
  nowIso: string,
): void {
  const stage = candidate.stage;
  const error: MarketingStageError = {
    code: STALE_REAPER_FAILURE_REASON,
    message: STALE_REAPER_ERROR_MESSAGE,
    stage,
    retryable: false,
    details: {
      previous_state: candidate.state,
      previous_status: candidate.status,
      silent_ms: candidate.silentMs,
      threshold_ms: candidate.thresholdMs,
      previous_progress_at: candidate.progressAt,
    },
    at: nowIso,
  };

  doc.state = 'failed';
  doc.status = 'failed_stale';
  doc.failure_reason = STALE_REAPER_FAILURE_REASON;
  doc.last_error = error;
  if (Array.isArray(doc.errors)) {
    doc.errors.push(error);
  } else {
    doc.errors = [error];
  }
  if (Array.isArray(doc.history)) {
    doc.history.push({
      at: nowIso,
      state: 'failed',
      status: 'failed_stale',
      stage,
      note: `stale-run reaper marked job failed after ${candidate.silentMs} ms without ${stage} progress`,
    });
  }
  doc.updated_at = nowIso;
}

export async function runStaleRunReaper(
  options: StaleRunReaperOptions,
): Promise<StaleRunReaperReport> {
  const dataRoot = path.normalize(options.dataRoot);
  const root = path.join(dataRoot, MARKETING_JOBS_SUBDIR);
  const thresholdsByStage = staleRunReaperThresholdsByStage();
  const thresholdMs = options.thresholdMs ?? staleRunReaperThresholdMs();
  const now = options.now ?? (() => new Date());
  const report: StaleRunReaperReport = {
    scanned: 0,
    candidates: [],
    mutated: 0,
    skipped: 0,
    errors: 0,
    thresholdMs,
    thresholdsByStage,
    dryRun: options.dryRun,
  };

  let entries: string[];
  try {
    entries = (await readdir(root)).filter((entry) => entry.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      logInfo('marketing-jobs root missing; nothing to reap', { root });
      return report;
    }
    report.errors += 1;
    logWarn('failed to enumerate marketing-jobs root', {
      root,
      error: (err as Error)?.message,
    });
    return report;
  }

  for (const entry of entries) {
    const filePath = path.join(root, entry);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      report.errors += 1;
      logWarn('failed to read runtime doc', { filePath, error: (err as Error)?.message });
      continue;
    }

    let parsed: Record<string, unknown> | null;
    try {
      const candidate = JSON.parse(raw) as unknown;
      parsed = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : null;
    } catch {
      parsed = null;
    }

    if (!parsed) {
      report.skipped += 1;
      continue;
    }

    if (!isKnownSchema(parsed.schema_name)) {
      report.skipped += 1;
      continue;
    }

    const jobId = asString(parsed.job_id);
    const tenantId = asString(parsed.tenant_id);
    if (!jobId || !tenantId) {
      report.skipped += 1;
      continue;
    }

    const state = asMarketingState(parsed.state);
    const status = asMarketingStatus(parsed.status);
    const stage = asMarketingStage(parsed.current_stage) ?? 'research';
    if (!state || !status) {
      report.skipped += 1;
      continue;
    }

    report.scanned += 1;

    if (isTerminalDoc(state, status)) {
      report.skipped += 1;
      continue;
    }

    if (alreadyReaped(parsed as unknown as MarketingJobRuntimeDocument)) {
      report.skipped += 1;
      continue;
    }

    if (!isInFlight(state, status)) {
      report.skipped += 1;
      continue;
    }

    const progressAtMs = latestProgressTimestamp(parsed, stage);
    if (progressAtMs === null) {
      report.skipped += 1;
      logWarn('runtime doc missing parseable progress timestamp; skipping', { jobId, filePath, stage });
      continue;
    }

    const candidateThresholdMs = options.thresholdMs ?? thresholdsByStage[stage];
    const nowMs = now().getTime();
    const silentMs = nowMs - progressAtMs;
    if (silentMs <= candidateThresholdMs) {
      report.skipped += 1;
      continue;
    }

    const candidate: StaleRunCandidate = {
      jobId,
      tenantId,
      state,
      status,
      stage,
      progressAt: new Date(progressAtMs).toISOString(),
      silentMs,
      thresholdMs: candidateThresholdMs,
      filePath,
      mutated: false,
    };

    if (options.dryRun) {
      logInfo('candidate (dry-run)', {
        jobId,
        tenantId,
        state,
        status,
        stage,
        silent_ms: silentMs,
        threshold_ms: candidateThresholdMs,
        filePath,
      });
      report.candidates.push(candidate);
      continue;
    }

    try {
      const doc = parsed as unknown as MarketingJobRuntimeDocument;
      applyStaleMarker(doc, candidate, new Date(nowMs).toISOString());
      await writeFile(filePath, JSON.stringify(doc, null, 2));
      candidate.mutated = true;
      report.mutated += 1;
      report.candidates.push(candidate);
      logInfo('reaped run', {
        jobId,
        tenantId,
        previous_state: state,
        previous_status: status,
        stage,
        silent_ms: silentMs,
        threshold_ms: candidateThresholdMs,
        filePath,
      });
    } catch (err) {
      report.errors += 1;
      logWarn('failed to apply stale marker', {
        jobId,
        filePath,
        error: (err as Error)?.message,
      });
    }
  }

  logInfo('summary', {
    dryRun: options.dryRun,
    scanned: report.scanned,
    candidates: report.candidates.length,
    mutated: report.mutated,
    skipped: report.skipped,
    errors: report.errors,
    threshold_ms: thresholdMs,
    thresholds_by_stage: thresholdsByStage,
  });

  return report;
}
