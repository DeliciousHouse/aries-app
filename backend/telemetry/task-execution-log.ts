/**
 * backend/telemetry/task-execution-log.ts
 *
 * AA-159 — classify every task execution by its processing engine and append it
 * to `task_execution_log`, so cost analysis can separate paid AI inference from
 * zero-cost deterministic automation and local/edge compute.
 *
 * Engines:
 *   - AI_LLM             — work executed by a model behind the Hermes gateway
 *                          (marketing pipeline stages, raw classification /
 *                          research runs). Cost-bearing.
 *   - DETERMINISTIC_RULE — rule-based automation with no model in the loop
 *                          (sidecar sweeps, schedulers, dispatchers). Zero token
 *                          cost by construction.
 *   - LOCAL_EDGE         — CPU work executed in-process on this host (sharp
 *                          compositing, ffmpeg reel/video assembly). Zero token
 *                          cost; the interesting number is CPU/wall time.
 *
 * Contracts this module enforces so the table is trustworthy to query:
 *   1. Non-AI engines ALWAYS log input_tokens = 0, output_tokens = 0,
 *      cost_cents = 0 (AC: "log zero token counts"), and never carry model
 *      fields — a model column on a LOCAL_EDGE row would be meaningless.
 *   2. AI rows record `model_requested` (the hint Aries SENT) separately from
 *      `model_reported` (what the gateway said it actually ran). Hermes owns
 *      model routing and does not currently report the resolved model or token
 *      usage back to Aries, so `model_reported`, the token columns, and
 *      `cost_cents` stay NULL on AI rows until the gateway reports them. NULL
 *      means "not reported", never "zero" — that distinction is the whole point
 *      of the analysis, so we do not synthesize costs from a price table.
 *   3. Writing is best-effort and NEVER throws: telemetry must not be able to
 *      fail a publish, a sweep, or a render.
 *   4. Nothing is written unless ARIES_TASK_TELEMETRY_ENABLED is on, and the
 *      insert is a single unpooled `query` — never a client held across a
 *      gateway call (guardrail #1: DB fan-out / pool pressure).
 */

import { pool } from '@/lib/db';

import { isTaskTelemetryEnabled } from './task-telemetry-env';

export const EXECUTION_ENGINES = ['AI_LLM', 'DETERMINISTIC_RULE', 'LOCAL_EDGE'] as const;
export type ExecutionEngine = (typeof EXECUTION_ENGINES)[number];

export type TaskExecutionStatus = 'succeeded' | 'failed';

/** Minimal query surface so tests can inject a fake without a live Postgres. */
export type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

export type TaskExecutionRecord = {
  /** Which engine actually did the work. */
  engine: ExecutionEngine;
  /** Stable identifier for the task, e.g. 'insights.classify_comments'. */
  taskKey: string;
  /** Tenant the work was done for; null for system/global tasks (sweeps). */
  tenantId?: string | number | null;
  status: TaskExecutionStatus;
  /** Short machine-readable failure reason; null on success. */
  errorCode?: string | null;
  /** Wall-clock duration. */
  durationMs?: number | null;
  /** CPU time consumed in-process (user+system). Required in spirit for LOCAL_EDGE. */
  cpuMs?: number | null;
  /** AI only: the model hint Aries sent to the gateway. */
  modelRequested?: string | null;
  /** AI only: the model the gateway reported running, when it reports one. */
  modelReported?: string | null;
  /** AI only: the Hermes profile / gateway the run was submitted to. */
  targetProfile?: string | null;
  /** AI only: the gateway-side run id, for joining back to Hermes. */
  externalRunId?: string | null;
  /** AI only: usage as reported by the gateway. NULL = not reported. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  costCents?: number | null;
  startedAt?: Date | null;
};

export type TaskExecutionRow = {
  tenant_id: number | null;
  execution_engine: ExecutionEngine;
  task_key: string;
  status: TaskExecutionStatus;
  error_code: string | null;
  duration_ms: number | null;
  cpu_ms: number | null;
  model_requested: string | null;
  model_reported: string | null;
  target_profile: string | null;
  external_run_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  started_at: Date | null;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function tenantIdColumn(value: TaskExecutionRecord['tenantId']): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Pure projection of a record onto its table row, applying the engine contracts
 * above. Exported so the zero-token / no-model-on-local invariants can be tested
 * without a database.
 */
export function normalizeTaskExecutionRow(record: TaskExecutionRecord): TaskExecutionRow {
  const isAi = record.engine === 'AI_LLM';
  return {
    tenant_id: tenantIdColumn(record.tenantId),
    execution_engine: record.engine,
    task_key: record.taskKey,
    status: record.status,
    error_code: record.status === 'failed' ? (text(record.errorCode) ?? 'error') : null,
    duration_ms: nonNegativeInt(record.durationMs),
    cpu_ms: nonNegativeInt(record.cpuMs),
    // Model routing is meaningful only for AI runs; a model on a local/rule row
    // would be noise in every cost query.
    model_requested: isAi ? text(record.modelRequested) : null,
    model_reported: isAi ? text(record.modelReported) : null,
    target_profile: isAi ? text(record.targetProfile) : null,
    external_run_id: isAi ? text(record.externalRunId) : null,
    // Zero-token contract: non-AI work costs no tokens BY CONSTRUCTION, so it is
    // recorded as a hard 0 rather than NULL ("unknown"). AI usage stays NULL
    // until the gateway reports it.
    input_tokens: isAi ? nonNegativeInt(record.inputTokens) : 0,
    output_tokens: isAi ? nonNegativeInt(record.outputTokens) : 0,
    cost_cents: isAi ? nonNegativeNumber(record.costCents) : 0,
    started_at: record.startedAt instanceof Date ? record.startedAt : null,
  };
}

const INSERT_SQL = `
  INSERT INTO task_execution_log (
    tenant_id, execution_engine, task_key, status, error_code,
    duration_ms, cpu_ms, model_requested, model_reported, target_profile,
    external_run_id, input_tokens, output_tokens, cost_cents, started_at
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8, $9, $10,
    $11, $12, $13, $14, COALESCE($15, now())
  )
`;

export type RecordTaskExecutionOptions = {
  db?: Queryable;
  env?: Partial<Record<string, string | undefined>>;
};

/**
 * Append one execution-log row. Best-effort: returns false (never throws) when
 * the flag is off or the write fails, so a telemetry outage can never break the
 * task being measured.
 */
export async function recordTaskExecution(
  record: TaskExecutionRecord,
  options: RecordTaskExecutionOptions = {},
): Promise<boolean> {
  if (!isTaskTelemetryEnabled(options.env ?? process.env)) return false;
  const row = normalizeTaskExecutionRow(record);
  const db = options.db ?? pool;
  try {
    await db.query(INSERT_SQL, [
      row.tenant_id,
      row.execution_engine,
      row.task_key,
      row.status,
      row.error_code,
      row.duration_ms,
      row.cpu_ms,
      row.model_requested,
      row.model_reported,
      row.target_profile,
      row.external_run_id,
      row.input_tokens,
      row.output_tokens,
      row.cost_cents,
      row.started_at,
    ]);
    return true;
  } catch (error) {
    console.warn('[task-execution-log] write failed', {
      taskKey: record.taskKey,
      engine: record.engine,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export type TaskExecutionSpec = Omit<
  TaskExecutionRecord,
  'status' | 'errorCode' | 'durationMs' | 'cpuMs' | 'startedAt'
> & {
  /** Derive extra AI metadata (model reported, usage, run id) from the result. */
  detailsFromResult?: (result: unknown) => Partial<TaskExecutionRecord>;
  /** Map a thrown error onto a short machine-readable code. */
  errorCodeFromError?: (error: unknown) => string;
};

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.trim()) return code.trim();
  return 'error';
}

/**
 * Run `fn`, measuring wall-clock and in-process CPU time, and append exactly one
 * execution-log row for it. The wrapped function's value is returned unchanged
 * and a thrown error is re-thrown unchanged — this wrapper is observational
 * only. `process.cpuUsage()` deltas are what make the LOCAL_EDGE rows useful:
 * a zero-token task's cost is entirely its compute time.
 */
export async function withTaskExecutionLog<T>(
  spec: TaskExecutionSpec,
  fn: () => Promise<T>,
  options: RecordTaskExecutionOptions = {},
): Promise<T> {
  if (!isTaskTelemetryEnabled(options.env ?? process.env)) {
    return fn();
  }
  const { detailsFromResult, errorCodeFromError, ...base } = spec;
  const startedAt = new Date();
  const startWall = Date.now();
  const startCpu = process.cpuUsage();

  const measure = () => {
    const cpu = process.cpuUsage(startCpu);
    return {
      durationMs: Date.now() - startWall,
      cpuMs: (cpu.user + cpu.system) / 1000,
    };
  };

  try {
    const result = await fn();
    const extra = detailsFromResult ? (detailsFromResult(result) ?? {}) : {};
    await recordTaskExecution(
      { ...base, ...extra, ...measure(), startedAt, status: 'succeeded' },
      options,
    );
    return result;
  } catch (error) {
    await recordTaskExecution(
      {
        ...base,
        ...measure(),
        startedAt,
        status: 'failed',
        errorCode: errorCodeFromError ? errorCodeFromError(error) : errorCodeOf(error),
      },
      options,
    );
    throw error;
  }
}
