/**
 * Background retry sweep for customer incident reports (SC-70 port). Heals
 * every parked outcome: Jira-down submissions, attach-only completions,
 * stale 'pending' rows stranded by a crash, and rows queued while Jira was
 * unconfigured (they heal automatically once the JIRA_* config lands).
 *
 * Runs from the aries-feedback-retry-worker sidecar. Concurrency-safe: the
 * claim is a single UPDATE over FOR UPDATE SKIP LOCKED (see claimRetryBatch),
 * committed before any Jira I/O, so two workers never double-claim and a
 * crashed worker's rows re-enter via the stale-pending window.
 */

import type { Pool, PoolClient } from 'pg';

import { withTaskExecutionLog } from '@/backend/telemetry/task-execution-log';
import type { FeedbackReportConfig } from './report-config';
import {
  claimRetryBatch,
  ensureFeedbackReportsTable,
  getFeedbackReportById,
  withFeedbackReportSyncLock,
} from './report-store';
import {
  poolSyncStore,
  rowToSyncable,
  syncReportToJira,
  type ReportSyncResult,
  type ReportSyncStore,
  type SyncableReport,
} from './report-sync';

export interface FeedbackRetrySweepReport {
  configured: boolean;
  claimed: number;
  synced: number;
  retried: number;
  failed: number;
  errors: number;
}

export interface RetrySweepDeps {
  claim?: typeof claimRetryBatch;
  ensureTable?: typeof ensureFeedbackReportsTable;
  getById?: typeof getFeedbackReportById;
  withSyncLock?: typeof withFeedbackReportSyncLock;
  sync?: (
    report: SyncableReport,
    config: FeedbackReportConfig,
    store: ReportSyncStore,
  ) => Promise<ReportSyncResult>;
  store?: ReportSyncStore;
  log?: (message: string) => void;
}

// The unconfigured notice logs once per process, not once per tick.
let loggedUnconfigured = false;

/** Test seam. */
export function resetRetrySweepLogMemoForTests(): void {
  loggedUnconfigured = false;
}

/**
 * One sweep cycle. Never throws: one row's failure never kills the loop, and
 * an unconfigured Jira is a quiet no-op (one info line per process).
 */
export async function runFeedbackRetrySweep(
  pool: Pool,
  config: FeedbackReportConfig,
  deps: RetrySweepDeps = {},
): Promise<FeedbackRetrySweepReport> {
  // AA-159: DETERMINISTIC_RULE work — claim/retry logic against Jira, no model
  // in the loop. Logged on the sweep's own pool (no extra pool acquired).
  return withTaskExecutionLog(
    { engine: 'DETERMINISTIC_RULE', taskKey: 'feedback.retry_sweep' },
    () => runFeedbackRetrySweepPass(pool, config, deps),
    { db: pool },
  );
}

async function runFeedbackRetrySweepPass(
  pool: Pool,
  config: FeedbackReportConfig,
  deps: RetrySweepDeps = {},
): Promise<FeedbackRetrySweepReport> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const report: FeedbackRetrySweepReport = {
    configured: config.jira !== null,
    claimed: 0,
    synced: 0,
    retried: 0,
    failed: 0,
    errors: 0,
  };

  if (!config.jira) {
    if (!loggedUnconfigured) {
      log('[feedback-retry-sweep] Jira is not configured; queued reports stay parked.');
      loggedUnconfigured = true;
    }
    return report;
  }

  try {
    const ensureTable = deps.ensureTable ?? ensureFeedbackReportsTable;
    await ensureTable(pool);

    const claim = deps.claim ?? claimRetryBatch;
    const rows = await claim(pool, {
      maxAttempts: config.retryMaxAttempts,
      stalePendingMinutes: config.stalePendingMinutes,
      batchLimit: config.retryBatchLimit,
    });
    report.claimed = rows.length;
    if (rows.length === 0) return report;

    const sync = deps.sync ?? syncReportToJira;
    const getById = deps.getById ?? getFeedbackReportById;
    const withSyncLock = deps.withSyncLock ?? withFeedbackReportSyncLock;

    for (const row of rows) {
      try {
        const result = await withSyncLock(pool, row.id, async (lockClient: PoolClient) => {
          // The claim snapshot may be stale by the time this worker reaches the
          // row. Reload while holding the SAME report lock used by browser
          // replays so every Jira entry point observes one serialized state.
          const latest = await getById(lockClient, row.id);
          if (!latest) throw new Error('claimed feedback report no longer exists');
          if (latest.status === 'synced') {
            return { status: 'synced' as const, ticketKey: latest.jira_ticket_key };
          }
          if (latest.status === 'failed') {
            return { status: 'failed' as const, ticketKey: latest.jira_ticket_key };
          }
          return sync(
            rowToSyncable(latest),
            config,
            deps.store ?? poolSyncStore(lockClient),
          );
        });
        if (result.status === 'synced') report.synced += 1;
        else if (result.status === 'failed') report.failed += 1;
        else report.retried += 1;
      } catch (error) {
        // A store write failed mid-sync: the row is left 'pending' and the
        // stale-pending reclaim will pick it back up next window.
        report.errors += 1;
        console.error('[feedback-retry-sweep] row error', {
          reportId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    report.errors += 1;
    console.error('[feedback-retry-sweep] cycle error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return report;
}
