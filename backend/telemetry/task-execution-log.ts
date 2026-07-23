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

/**
 * 'retry' is a NON-TERMINAL attempt that will be retried. It is logged as its
 * own event so the tokens burned on retries are attributable separately from
 * the attempt that finally settles (AA-158) — summing only succeeded/failed
 * rows gives settled cost, summing all rows gives true spend.
 */
export type TaskExecutionStatus = 'succeeded' | 'failed' | 'retry';

/** Minimal query surface so tests can inject a fake without a live Postgres. */
export type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

export type TaskExecutionRecord = {
  /** Which engine actually did the work. */
  engine: ExecutionEngine;
  /** Stable identifier for the task, e.g. 'insights.classify_comments'. */
  taskKey: string;
  /** Tenant ("company") the work was done for; null for system tasks (sweeps). */
  tenantId?: string | number | null;
  /**
   * Operator who initiated the task. NULL on the majority of executions by
   * design — the weekly cron, the sidecars, the reconciler and every Hermes
   * callback are userless; only a route-initiated task has a session user.
   */
  userId?: string | number | null;
  /**
   * Per-EXECUTION identifier (aries_run_id / job id / generated uuid), as
   * opposed to taskKey which identifies the task TYPE. Joins every attempt of
   * the same logical task together.
   */
  taskId?: string | null;
  status: TaskExecutionStatus;
  /** 1-based attempt counter; >1 means this execution is a retry. */
  attemptNumber?: number | null;
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
  /**
   * AI only: usage as reported by the gateway. NULL = not reported (Hermes does
   * not report usage today), never "free". totalTokens is derived from the pair
   * when the caller does not supply it.
   */
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  costCents?: number | null;
  startedAt?: Date | null;
  endTime?: Date | null;
};

export type TaskExecutionRow = {
  tenant_id: number | null;
  user_id: number | null;
  task_id: string | null;
  execution_engine: ExecutionEngine;
  task_key: string;
  status: TaskExecutionStatus;
  attempt_number: number;
  error_code: string | null;
  duration_ms: number | null;
  cpu_ms: number | null;
  model_requested: string | null;
  model_reported: string | null;
  target_profile: string | null;
  external_run_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_cents: number | null;
  started_at: Date | null;
  end_time: Date | null;
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

function idColumn(value: string | number | null | undefined): number | null {
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
 * total_tokens: the caller's value when given, else the sum of the pair when
 * BOTH halves are known. Never a partial sum — one known half plus an unknown
 * half is an unknown total, and a half-total silently understates spend.
 */
function totalTokensColumn(record: TaskExecutionRecord): number | null {
  const explicit = nonNegativeInt(record.totalTokens);
  if (explicit !== null) return explicit;
  const prompt = nonNegativeInt(record.promptTokens);
  const completion = nonNegativeInt(record.completionTokens);
  if (prompt === null || completion === null) return null;
  return prompt + completion;
}

/**
 * Pure projection of a record onto its table row, applying the engine contracts
 * above. Exported so the zero-token / no-model-on-local invariants can be tested
 * without a database.
 */
export function normalizeTaskExecutionRow(record: TaskExecutionRecord): TaskExecutionRow {
  const isAi = record.engine === 'AI_LLM';
  const attempt = nonNegativeInt(record.attemptNumber);
  return {
    tenant_id: idColumn(record.tenantId),
    user_id: idColumn(record.userId),
    task_id: text(record.taskId),
    execution_engine: record.engine,
    task_key: record.taskKey,
    status: record.status,
    attempt_number: attempt && attempt >= 1 ? attempt : 1,
    // A retry event carries a reason too — it is a failed attempt that will be
    // tried again, so dropping its error code would lose why it is being retried.
    error_code:
      record.status === 'succeeded' ? null : (text(record.errorCode) ?? 'error'),
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
    prompt_tokens: isAi ? nonNegativeInt(record.promptTokens) : 0,
    completion_tokens: isAi ? nonNegativeInt(record.completionTokens) : 0,
    total_tokens: isAi ? totalTokensColumn(record) : 0,
    cost_cents: isAi ? nonNegativeNumber(record.costCents) : 0,
    started_at: record.startedAt instanceof Date ? record.startedAt : null,
    end_time: record.endTime instanceof Date ? record.endTime : null,
  };
}

/** Column order of one row's parameter tuple; shared by the single + batch path. */
const COLUMN_COUNT = 20;

function rowParams(row: TaskExecutionRow): unknown[] {
  return [
    row.tenant_id,
    row.user_id,
    row.task_id,
    row.execution_engine,
    row.task_key,
    row.status,
    row.attempt_number,
    row.error_code,
    row.duration_ms,
    row.cpu_ms,
    row.model_requested,
    row.model_reported,
    row.target_profile,
    row.external_run_id,
    row.prompt_tokens,
    row.completion_tokens,
    row.total_tokens,
    row.cost_cents,
    row.started_at,
    row.end_time,
  ];
}

const INSERT_COLUMNS = `
  INSERT INTO task_execution_log (
    tenant_id, user_id, task_id, execution_engine, task_key,
    status, attempt_number, error_code, duration_ms, cpu_ms,
    model_requested, model_reported, target_profile, external_run_id, prompt_tokens,
    completion_tokens, total_tokens, cost_cents, started_at, end_time
  ) VALUES `;

/**
 * `VALUES ($1,...,$20), ($21,...)` for `count` rows. started_at (offset 19 of
 * 20) keeps its COALESCE-to-now default so a caller that omits it still lands a
 * sane timestamp.
 */
function insertSql(count: number): string {
  const tuples: string[] = [];
  for (let r = 0; r < count; r++) {
    const base = r * COLUMN_COUNT;
    const placeholders: string[] = [];
    for (let c = 1; c <= COLUMN_COUNT; c++) {
      placeholders.push(c === 19 ? `COALESCE($${base + c}, now())` : `$${base + c}`);
    }
    tuples.push(`(${placeholders.join(', ')})`);
  }
  return `${INSERT_COLUMNS}${tuples.join(', ')}`;
}

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
    await db.query(insertSql(1), rowParams(row));
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

// ---------------------------------------------------------------------------
// AA-158: non-blocking emit
// ---------------------------------------------------------------------------
//
// AC: "handles high-throughput asynchronous events without blocking task
// execution". recordTaskExecution AWAITS its INSERT, so a caller on a hot path
// pays the DB round-trip. emitTaskExecution instead buffers in memory and
// returns synchronously; a microtask-scheduled flush writes the whole buffer as
// ONE multi-row INSERT.
//
// Deliberately in-process and lossy-under-pressure rather than a durable
// outbox: telemetry must never cost more than the work it measures, and a
// durable queue would double the write volume of the thing being metered. The
// buffer is bounded — past the cap the OLDEST events are dropped and counted,
// so a stalled database degrades to missing telemetry, never to unbounded
// memory growth or backpressure on publishing.

const MAX_BUFFERED_EVENTS = 500;
/** Rows per INSERT. 20 columns × 100 rows = 2000 params, well under PG's 65535. */
const MAX_FLUSH_BATCH = 100;

type Buffered = { row: TaskExecutionRow; db: Queryable };

const buffer: Buffered[] = [];
let flushScheduled = false;
let droppedEvents = 0;
let inFlight: Promise<void> | null = null;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // A macrotask, not a microtask: the calling task's own continuation runs first.
  setTimeout(() => {
    flushScheduled = false;
    inFlight = flushTaskExecutionBuffer();
  }, 0).unref?.();
}

/**
 * Drain the buffer. Groups by db handle (a caller may pass its own client) and
 * writes each group in batches. Never throws: a failed batch is dropped and
 * counted rather than retried, so a database outage cannot wedge the buffer.
 */
export async function flushTaskExecutionBuffer(): Promise<void> {
  while (buffer.length > 0) {
    const batch = buffer.splice(0, MAX_FLUSH_BATCH);
    // Preserve caller-supplied handles: group consecutive rows sharing one db.
    const groups = new Map<Queryable, TaskExecutionRow[]>();
    for (const item of batch) {
      const existing = groups.get(item.db);
      if (existing) existing.push(item.row);
      else groups.set(item.db, [item.row]);
    }
    for (const [db, rows] of groups) {
      try {
        await db.query(insertSql(rows.length), rows.flatMap(rowParams));
      } catch (error) {
        droppedEvents += rows.length;
        console.warn('[task-execution-log] batch flush failed — events dropped', {
          dropped: rows.length,
          totalDropped: droppedEvents,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** Buffered-event counters, for tests and for an ops readout. */
export function taskExecutionBufferStats(): { pending: number; dropped: number } {
  return { pending: buffer.length, dropped: droppedEvents };
}

/** Test seam: clear buffer + counters between cases. */
export function resetTaskExecutionBuffer(): void {
  buffer.length = 0;
  droppedEvents = 0;
  flushScheduled = false;
  inFlight = null;
}

/**
 * Await whatever flush is currently in flight. Tests use this; production code
 * never needs it, which is the point — emitting is fire-and-forget.
 */
export async function settleTaskExecutionBuffer(): Promise<void> {
  await flushTaskExecutionBuffer();
  if (inFlight) await inFlight;
}

/**
 * Emit an execution event WITHOUT blocking the caller. Returns synchronously.
 * Use this on hot paths; use recordTaskExecution when the caller genuinely
 * wants the write settled (e.g. it holds a client that is about to be released).
 */
export function emitTaskExecution(
  record: TaskExecutionRecord,
  options: RecordTaskExecutionOptions = {},
): void {
  if (!isTaskTelemetryEnabled(options.env ?? process.env)) return;
  if (buffer.length >= MAX_BUFFERED_EVENTS) {
    // Drop the OLDEST: under sustained pressure the newest events are the ones
    // still worth having, and an unbounded buffer would trade a telemetry gap
    // for an OOM in the process doing the real work.
    buffer.shift();
    droppedEvents++;
  }
  buffer.push({ row: normalizeTaskExecutionRow(record), db: options.db ?? pool });
  scheduleFlush();
}

export type TaskExecutionSpec = Omit<
  TaskExecutionRecord,
  'status' | 'errorCode' | 'durationMs' | 'cpuMs' | 'startedAt' | 'endTime'
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
      // AA-158 wants start/end as well as the derived duration, so a consumer
      // can bucket by wall-clock window without re-deriving it.
      endTime: new Date(),
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
