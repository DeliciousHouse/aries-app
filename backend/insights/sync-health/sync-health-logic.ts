/**
 * backend/insights/sync-health/sync-health-logic.ts
 *
 * S6-3 / AA-116 (gap F4a) — pure logic for the sync-health read model.
 * No DB, no I/O.
 *
 * `insights_sync_runs` has been write-only: the dispatcher appends to it, the
 * stranded-run sweep repairs it, and nothing ever reads it back except the
 * freshness stamp's single worst-wins status. So when a tenant's sync breaks,
 * the operator sees "stale" with no way to learn WHY. This module turns those
 * rows into an answer.
 *
 * It also owns the consecutive-failure streak, which S6-4/AA-117 alerts on —
 * deliberately here rather than in the alerting code, so "what counts as a
 * failure streak" has exactly one definition and the endpoint an operator reads
 * can never disagree with the alert that pages them.
 */

/** The exact message the stranded-run sweep stamps. Not a failure of the sync. */
export const RESTART_ABORT_MESSAGE = 'aborted by worker restart';

export type SyncRunStatus = 'running' | 'ok' | 'partial' | 'failed';

/** Coarse, frontend-safe classification of why a run failed. */
export type SyncFailureCategory =
  | 'restart_abort'
  | 'auth'
  | 'rate_limit'
  | 'not_configured'
  | 'other';

export interface SyncRunRow {
  id: number;
  platform: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  status: SyncRunStatus;
  postsSeen: number;
  commentsSeen: number;
  apiUnitsUsed: number;
  errorMessage: string | null;
}

/**
 * A run the sweep failed out because the worker was restarted mid-flight.
 *
 * This is the load-bearing distinction for AA-117: every deploy restarts the
 * sync worker, so any in-flight run becomes `failed`. Counting those would page
 * on every single deploy — the alert would be noise from day one and get muted,
 * which is worse than not having it.
 */
export function isRestartAbort(run: Pick<SyncRunRow, 'errorMessage'>): boolean {
  return (run.errorMessage ?? '').trim().toLowerCase() === RESTART_ABORT_MESSAGE;
}

/**
 * Bucket a raw adapter error into something safe to show any role.
 *
 * The raw `error_message` is third-party API text and may carry request ids,
 * account identifiers or provider internals, so it is only ever handed to a
 * tenant_admin (see the handler). Everyone else gets one of these categories,
 * which is enough to act on — "reconnect the account" vs "wait and retry".
 */
export function classifySyncFailure(errorMessage: string | null | undefined): SyncFailureCategory {
  const text = (errorMessage ?? '').toLowerCase();
  if (!text.trim()) return 'other';
  if (text === RESTART_ABORT_MESSAGE) return 'restart_abort';
  if (/\b(oauth|token|unauthor|forbidden|reauth|credential|expired|401|403)\b/.test(text)) {
    return 'auth';
  }
  if (/\b(rate.?limit|too many requests|quota|throttl|429)\b/.test(text)) return 'rate_limit';
  if (/\b(not_configured|not configured|missing .*key|no adapter|disabled)\b/.test(text)) {
    return 'not_configured';
  }
  return 'other';
}

/**
 * Consecutive failed runs, newest-first, per the AA-117 contract.
 *
 * Rules, in order:
 *  - `ok` / `partial` BREAK the streak. A partial run still persisted data; it
 *    is a degraded success, not a failure.
 *  - restart-aborts are SKIPPED entirely — they neither extend nor break it, so
 *    a deploy in the middle of a genuine outage does not reset the count and
 *    hide it.
 *  - `running` is skipped: it has no outcome yet, and treating an in-flight run
 *    as either result would be inventing one.
 *
 * `runs` MUST be ordered newest-first; the caller's ORDER BY is what makes this
 * meaningful.
 */
export function consecutiveFailureStreak(runs: readonly SyncRunRow[]): number {
  let streak = 0;
  for (const run of runs) {
    if (run.status === 'running') continue;
    if (isRestartAbort(run)) continue;
    if (run.status === 'failed') {
      streak += 1;
      continue;
    }
    break; // ok | partial
  }
  return streak;
}

export interface FailureEpisode {
  streak: number;
  /**
   * The id of the OLDEST run in the current unbroken failure streak — a stable
   * identifier for THIS outage.
   *
   * S6-4/AA-117 dedupes on it. Keying an alert on (tenant, platform) alone would
   * page once ever and stay silent through every future outage; keying on the
   * NEWEST run id would re-page on every tick, since each tick adds a run. The
   * episode start is the only id that is constant while an outage continues and
   * different once the sync recovers and later breaks again.
   */
  firstFailedRunId: number | null;
}

/** The current unbroken failure streak, and the run that started it. */
export function currentFailureEpisode(runs: readonly SyncRunRow[]): FailureEpisode {
  let streak = 0;
  let firstFailedRunId: number | null = null;
  for (const run of runs) {
    if (run.status === 'running') continue;
    if (isRestartAbort(run)) continue;
    if (run.status === 'failed') {
      streak += 1;
      firstFailedRunId = run.id; // keeps moving back to the oldest in the streak
      continue;
    }
    break;
  }
  return { streak, firstFailedRunId };
}

export interface PlatformSyncHealth {
  platform: string;
  latestStatus: SyncRunStatus | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  failureCategory: SyncFailureCategory | null;
}

/** Per-platform rollup over runs already ordered newest-first. */
export function summarizeByPlatform(runs: readonly SyncRunRow[]): PlatformSyncHealth[] {
  const byPlatform = new Map<string, SyncRunRow[]>();
  for (const run of runs) {
    const list = byPlatform.get(run.platform);
    if (list) list.push(run);
    else byPlatform.set(run.platform, [run]);
  }

  return [...byPlatform.entries()]
    .map(([platform, platformRuns]) => {
      const terminal = platformRuns.filter((r) => r.status !== 'running');
      const latest = terminal[0] ?? null;
      const lastSuccess = terminal.find((r) => r.status === 'ok' || r.status === 'partial');
      const streak = consecutiveFailureStreak(platformRuns);
      return {
        platform,
        latestStatus: latest?.status ?? null,
        lastSuccessAt: lastSuccess?.finishedAt ?? null,
        consecutiveFailures: streak,
        failureCategory:
          streak > 0 && latest ? classifySyncFailure(latest.errorMessage) : null,
      };
    })
    .sort((a, b) => a.platform.localeCompare(b.platform));
}
