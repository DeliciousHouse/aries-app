/**
 * backend/insights/sync/sweep-stranded-runs.ts
 *
 * Stranded-run sweep for insights_sync_runs.
 *
 * The dispatcher (./dispatcher.ts) opens each sync run as status='running' and
 * only flips it to ok/failed at the end of a long multi-fetch sequence. A
 * SIGTERM mid-tick — docker compose stop's 10s grace then SIGKILL, routine
 * once every deploy force-recreates the sidecars — kills the worker before the
 * flip and strands the row in 'running' forever; no reaper covers this table.
 * (A swallowed failure of the dispatcher's best-effort failed-path UPDATE
 * strands a row the same way, with no restart involved.)
 *
 * The insights-sync worker runs this sweep at the top of every tick (the
 * first tick fires at startup), so a stranded row is cleaned within one
 * interval of aging past the grace window. The grace window keeps the sweep
 * away from syncs genuinely in flight in another process (handler-triggered
 * syncs in the app container finish in seconds; no legitimate run approaches
 * an hour today). Even if a long run were swept mid-flight, the dispatcher's
 * terminal UPDATEs key on id alone and the ok path clears error_message, so
 * the true outcome fully wins — enforced by
 * tests/insights-sync-runs-sweep.requires-infra.test.ts against real Postgres.
 *
 * Deliberately reuses status='failed' with a distinctive error_message instead
 * of widening the SyncStatus union. Served by the partial index
 * idx_insights_sync_runs_running_started (scripts/init-db.js), which stays
 * near-empty because 'running' rows are transient.
 *
 * Lives in backend/ per repo convention (the worker script is just the loop +
 * config + logging — same split as backend/marketing/draft-expiry-sweep.ts).
 */

import { withTaskExecutionLog } from '@/backend/telemetry/task-execution-log';

export const DEFAULT_STRANDED_RUN_GRACE_MINUTES = 60;

/**
 * Grace window (minutes) before a 'running' row is considered stranded.
 * Override with ARIES_INSIGHTS_SWEEP_GRACE_MINUTES — widen it before shipping
 * any sync path that can legitimately run long (e.g. a backfill script).
 * A non-positive, fractional, or unparseable value falls back to the default,
 * matching the other workers' interval knobs.
 */
export function strandedRunGraceMinutes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env['ARIES_INSIGHTS_SWEEP_GRACE_MINUTES'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_STRANDED_RUN_GRACE_MINUTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_STRANDED_RUN_GRACE_MINUTES;
  }
  return parsed;
}

/**
 * Exported so the requires-infra test executes this exact statement against
 * the real schema — the in-memory tests only see its shape. $1 is the grace
 * window in minutes.
 */
export const SWEEP_STRANDED_SYNC_RUNS_SQL = `
  UPDATE insights_sync_runs
  SET status        = 'failed',
      finished_at   = now(),
      error_message = 'aborted by worker restart'
  WHERE status = 'running'
    AND started_at < now() - make_interval(mins => $1)
`;

/**
 * Minimal pool surface the sweep needs; the real `pg` Pool (and the worker's
 * TickPool fakes) satisfy it structurally.
 */
export type SweepPool = {
  connect(): Promise<{
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{ rowCount?: number | null }>;
    release(): void;
  }>;
};

/** Fails out stranded 'running' rows; returns how many were swept. */
export async function sweepAbandonedSyncRuns(dbPool: SweepPool): Promise<number> {
  const client = await dbPool.connect();
  try {
    // AA-159: DETERMINISTIC_RULE work (one predicate UPDATE, no model). Logged
    // on the client this sweep already holds, so it costs no extra connection.
    return await withTaskExecutionLog(
      { engine: 'DETERMINISTIC_RULE', taskKey: 'insights.sweep_stranded_sync_runs' },
      async () => {
        const res = await client.query(SWEEP_STRANDED_SYNC_RUNS_SQL, [strandedRunGraceMinutes()]);
        return res.rowCount ?? 0;
      },
      { db: client },
    );
  } finally {
    client.release();
  }
}
