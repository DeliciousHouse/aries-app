/**
 * Durable Hermes run reconciler.
 *
 * Hermes `/v1/runs` is a POLLED API — it never POSTs the submission's
 * `callback_url`. Aries normally compensates with an in-process "poll bridge"
 * (backend/marketing/ports/hermes.ts::runPollBridge), a fire-and-forget promise
 * spawned by the request that submitted the run. In the Next.js prod runtime
 * that detached promise is not guaranteed to survive long enough to deliver, so
 * completed runs are never ingested and the stale-run reaper eventually fails
 * every marketing job (the systemic outage observed since 2026-05-27).
 *
 * This reconciler is the durable replacement. It is driven by a dedicated,
 * always-running worker process (scripts/hermes-reconciler-worker.ts) that
 * re-discovers in-flight execution runs from disk every tick and drives each to
 * terminal via the SAME idempotent callback path the bridge uses. Because it is
 * a standing process (not a per-request promise) it survives request churn and
 * restarts with the container.
 *
 * It does NOT discard work on transient errors (a flaky Hermes GET leaves the
 * run for the next tick) and it does NOT revive runs the reaper already failed —
 * un-reaping historical runs writes prod state and is intentionally out of
 * scope here.
 */
import { HermesMarketingPort, type ReconcileRunOutcome } from './ports/hermes';
import {
  isTerminalExecutionStatus,
  listExecutionRunRecords,
  type ExecutionRunRecord,
} from '../execution/run-store';

type ReconcilerEnv = Partial<Record<string, string | undefined>>;

/** Minimal port surface the reconciler needs — lets tests inject a fake. */
export interface ReconcilablePort {
  reconcileExecutionRun(
    ariesRunId: string,
    opts?: { record?: ExecutionRunRecord },
  ): Promise<ReconcileRunOutcome>;
}

export type HermesReconcilerOptions = {
  env?: ReconcilerEnv;
  /** Override the port (tests). Defaults to a real HermesMarketingPort. */
  port?: ReconcilablePort;
  /** Override the record source (tests). Defaults to the on-disk run store. */
  listRecords?: () => ExecutionRunRecord[];
  /** Clock injection (tests). */
  now?: () => number;
  /**
   * Skip runs created less than this many ms ago. 0 (default) reconciles
   * immediately — a still-running run just returns `pending`, which is cheap.
   */
  minAgeMs?: number;
  /**
   * Only scan execution-run files touched within this window (mtime), to keep
   * the per-tick scan from scaling with all runs ever created. 0 disables the
   * filter. Default 24h — far exceeds the max stale-run reaper threshold
   * (90 min), so a reconcilable run is never skipped.
   */
  maxRecordAgeMs?: number;
};

export type HermesReconcilerReport = {
  scanned: number;
  candidates: number;
  ingested: number;
  pending: number;
  skipped: number;
  errors: number;
  details: Array<{ ariesRunId: string; outcome: string; detail?: string }>;
};

const DEFAULT_MIN_AGE_MS = 0;
const DEFAULT_MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000; // 24h

function resolveMinAgeMs(env: ReconcilerEnv, override?: number): number {
  if (typeof override === 'number' && override >= 0) {
    return override;
  }
  const raw = env.ARIES_RECONCILER_MIN_AGE_MS?.trim();
  if (!raw) return DEFAULT_MIN_AGE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_AGE_MS;
}

function resolveMaxRecordAgeMs(env: ReconcilerEnv, override?: number): number {
  if (typeof override === 'number' && override >= 0) {
    return override;
  }
  const raw = env.ARIES_RECONCILER_MAX_RECORD_AGE_MS?.trim();
  if (!raw) return DEFAULT_MAX_RECORD_AGE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_RECORD_AGE_MS;
}

/**
 * Cheap pre-filter: which records are worth a Hermes GET? Mirrors the guards in
 * reconcileExecutionRun so we avoid network calls for obviously-skippable runs.
 */
function isReconcileCandidate(record: ExecutionRunRecord, nowMs: number, minAgeMs: number): boolean {
  if (record.provider !== 'hermes') return false;
  if (record.domain !== 'marketing') return false;
  if (isTerminalExecutionStatus(record.status)) return false;
  if (record.status === 'awaiting_approval') return false;
  if (!record.external_run_id) return false;
  if (!record.stage) return false;
  if (minAgeMs > 0) {
    const created = Date.parse(record.created_at);
    if (Number.isFinite(created) && nowMs - created < minAgeMs) {
      return false;
    }
  }
  return true;
}

/**
 * One reconciliation sweep over every in-flight marketing execution run.
 *
 * Runs are processed SEQUENTIALLY on purpose: ingestion (handleHermesRunCallback
 * → applyHermesMarketingCallback) touches Postgres, and operational guardrail #1
 * forbids fanning DB work out with Promise.all. Sequential keeps the reconciler
 * to ~1 concurrent ingestion regardless of how many runs completed at once.
 */
export async function runHermesReconciler(
  options: HermesReconcilerOptions = {},
): Promise<HermesReconcilerReport> {
  const env = options.env ?? process.env;
  const port = options.port ?? new HermesMarketingPort(env);
  const maxRecordAgeMs = resolveMaxRecordAgeMs(env, options.maxRecordAgeMs);
  const listRecords =
    options.listRecords ??
    (() => listExecutionRunRecords(maxRecordAgeMs > 0 ? { modifiedWithinMs: maxRecordAgeMs } : {}));
  const nowMs = (options.now ?? (() => Date.now()))();
  const minAgeMs = resolveMinAgeMs(env, options.minAgeMs);

  const records = listRecords();
  const report: HermesReconcilerReport = {
    scanned: records.length,
    candidates: 0,
    ingested: 0,
    pending: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  for (const record of records) {
    if (!isReconcileCandidate(record, nowMs, minAgeMs)) {
      continue;
    }
    report.candidates += 1;
    try {
      // Reuse the record we already loaded — avoids a second readFile+JSON.parse
      // per candidate inside reconcileExecutionRun.
      const outcome = await port.reconcileExecutionRun(record.aries_run_id, { record });
      switch (outcome.status) {
        case 'ingested':
          report.ingested += 1;
          report.details.push({
            ariesRunId: record.aries_run_id,
            outcome: `ingested:${outcome.callbackStatus}${outcome.duplicate ? ':duplicate' : ''}`,
          });
          break;
        case 'pending':
          report.pending += 1;
          break;
        case 'skipped':
          report.skipped += 1;
          break;
        case 'error':
          report.errors += 1;
          report.details.push({
            ariesRunId: record.aries_run_id,
            outcome: 'error',
            detail: outcome.reason,
          });
          break;
      }
    } catch (err) {
      report.errors += 1;
      report.details.push({
        ariesRunId: record.aries_run_id,
        outcome: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}
