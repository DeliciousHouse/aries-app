/**
 * backend/insights/sync-alerts/sync-failure-alerts.ts
 *
 * S6-4 / AA-117 (gap F4b) — Slack alert on N consecutive failed sync runs.
 *
 * ARCHITECTURE (the load-bearing part of this card). The alert is derived and
 * sent from the APP process, never from the sync worker.
 *
 * The `aries-insights-sync-worker` service has no Slack env at all —
 * ARIES_SLACK_NOTIFICATIONS_ENABLED, SLACK_*, and OAUTH_TOKEN_ENCRYPTION_KEY are
 * scoped to `aries-app` by CLAUDE.md, and it has neither APP_BASE_URL nor
 * INTERNAL_API_SECRET either. The Slack notify path is fail-open by design, so a
 * worker-side call would not error — it would resolve no config, skip, and
 * return success. The alert would silently never fire, and nothing would look
 * broken. That is the failure mode this design exists to avoid.
 *
 * Of the two architectures the card allows, this takes the second: the app
 * DERIVES the streak from `insights_sync_runs` on a reconciler-style tick. It is
 * preferred over the worker POSTing an event because it needs no new env on the
 * worker, and because it still fires when the worker is dead or wedged — the
 * case where an operator most needs to hear from us.
 *
 * The query applies the same per-platform terminal-run rules as AA-116 while
 * aggregating the full current episode, so long outages keep a stable identity.
 */

import type { Pool } from 'pg';

import {
  classifySyncFailure,
  currentFailureEpisode,
  isRestartAbort,
  type SyncRunRow,
} from '../sync-health/sync-health-logic';

export const DEFAULT_SYNC_FAILURE_ALERT_THRESHOLD = 3;

type Env = Partial<Record<string, string | undefined>>;

export function isSyncFailureAlertEnabled(env: Env = process.env): boolean {
  const v = env.ARIES_SYNC_FAILURE_ALERT_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function syncFailureAlertThreshold(env: Env = process.env): number {
  // Require a PLAIN integer string. `Number('1e2')` is 100, so a bare
  // Number.isInteger check would silently accept exponent notation and set the
  // pager threshold to something nobody typed — the same trap CLAUDE.md
  // documents for parsePoolMax and the insights force-throttle burst.
  const raw = env.ARIES_SYNC_FAILURE_ALERT_THRESHOLD?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return DEFAULT_SYNC_FAILURE_ALERT_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_SYNC_FAILURE_ALERT_THRESHOLD;
  return parsed;
}

/** Stable per-outage dedupe key. See FailureEpisode.firstFailedRunId. */
export function syncAlertDedupKey(
  tenantId: number,
  platform: string,
  firstFailedRunId: number,
): string {
  return `sync-failure:${tenantId}:${platform}:${firstFailedRunId}`;
}

/** Current failure episodes, aggregated so the outage identity never rolls off a window. */
export const SYNC_ALERT_RUNS_SQL = `
  WITH meaningful AS (
    SELECT
      r.tenant_id,
      r.id,
      r.platform,
      r.status,
      r.error_message,
      COALESCE(r.finished_at, r.started_at) AS event_at
    FROM insights_sync_runs r
    WHERE r.status <> 'running'
      AND NOT (
        r.status = 'failed'
        AND lower(btrim(COALESCE(r.error_message, ''))) = 'aborted after application restart'
      )
  ), ordered AS (
    SELECT
      meaningful.*,
      COUNT(*) FILTER (WHERE status IN ('ok', 'partial')) OVER (
        PARTITION BY tenant_id, platform
        ORDER BY event_at DESC, id DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS newer_successes
    FROM meaningful
  )
  SELECT
    tenant_id,
    platform,
    COUNT(*)::int AS streak,
    (array_agg(id ORDER BY event_at ASC, id ASC))[1] AS first_failed_run_id,
    (array_agg(error_message ORDER BY event_at DESC, id DESC))[1] AS latest_error_message
  FROM ordered
  WHERE status = 'failed' AND newer_successes = 0
  GROUP BY tenant_id, platform
  HAVING COUNT(*) >= $1
  ORDER BY tenant_id, platform
`;

export interface SyncAlertQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface SyncAlertCandidate {
  tenantId: number;
  platform: string;
  streak: number;
  firstFailedRunId: number;
  failureCategory: string;
  dedupKey: string;
}

type SyncAlertEpisodeRow = {
  tenant_id: number | string;
  platform: string;
  streak: number | string;
  first_failed_run_id: number | string;
  latest_error_message: string | null;
};

/**
 * Which (tenant, platform) pairs are currently in an alertable outage.
 * Pure over the fetched rows so the threshold behaviour is unit-testable.
 */
export function selectAlertCandidates(
  rows: readonly (SyncRunRow & { tenantId: number })[],
  threshold: number,
): SyncAlertCandidate[] {
  const groups = new Map<string, (SyncRunRow & { tenantId: number })[]>();
  for (const row of rows) {
    const key = `${row.tenantId}::${row.platform}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const candidates: SyncAlertCandidate[] = [];
  for (const runs of groups.values()) {
    const { streak, firstFailedRunId } = currentFailureEpisode(runs);
    if (streak < threshold || firstFailedRunId === null) continue;
    const first = runs[0];
    const latestFailed = runs.find((run) => run.status === 'failed' && !isRestartAbort(run));
    candidates.push({
      tenantId: first.tenantId,
      platform: first.platform,
      streak,
      firstFailedRunId,
      failureCategory: classifySyncFailure(latestFailed?.errorMessage),
      dedupKey: syncAlertDedupKey(first.tenantId, first.platform, firstFailedRunId),
    });
  }
  return candidates.sort(
    (a, b) => a.tenantId - b.tenantId || a.platform.localeCompare(b.platform),
  );
}

export interface SyncAlertDeps {
  db: SyncAlertQueryable;
  /** Sends one alert. Injected so the sweep is testable without Slack. */
  send: (candidate: SyncAlertCandidate, db?: SyncAlertQueryable) => Promise<boolean>;
  /** Already-delivered check + record, keyed on the episode. */
  alreadySent: (dedupKey: string, db?: SyncAlertQueryable) => Promise<boolean>;
  recordSent: (candidate: SyncAlertCandidate, db?: SyncAlertQueryable) => Promise<void>;
  withCandidateLock?: <T>(
    dedupKey: string,
    task: (db: SyncAlertQueryable) => Promise<T>,
  ) => Promise<T | null>;
  env?: Env;
}

export interface SyncAlertSweepReport {
  scanned: number;
  candidates: number;
  sent: number;
  deduped: number;
  failed: number;
}

/**
 * One sweep. Best-effort throughout: a per-candidate failure is isolated so one
 * tenant's broken Slack config cannot suppress every other tenant's alert.
 *
 * The dedupe row is written only AFTER a successful send, matching the shipped
 * approval-notification contract — a crashed send leaves no row and the next
 * tick retries, rather than marking an alert delivered that nobody received.
 */
export async function runSyncFailureAlertSweep(
  deps: SyncAlertDeps,
): Promise<SyncAlertSweepReport> {
  const env = deps.env ?? process.env;
  const report: SyncAlertSweepReport = {
    scanned: 0,
    candidates: 0,
    sent: 0,
    deduped: 0,
    failed: 0,
  };
  if (!isSyncFailureAlertEnabled(env)) return report;

  const threshold = syncFailureAlertThreshold(env);
  let rows: SyncAlertEpisodeRow[];
  try {
    const res = await deps.db.query<SyncAlertEpisodeRow>(SYNC_ALERT_RUNS_SQL, [
      threshold,
    ]);
    rows = res.rows;
  } catch (error) {
    console.error('[sync-failure-alerts] run scan failed', error);
    return report;
  }
  report.scanned = rows.reduce((total, row) => total + Number(row.streak), 0);
  const candidates = rows.map((row) => {
    const tenantId = Number(row.tenant_id);
    const firstFailedRunId = Number(row.first_failed_run_id);
    return {
      tenantId,
      platform: row.platform,
      streak: Number(row.streak),
      firstFailedRunId,
      failureCategory: classifySyncFailure(row.latest_error_message),
      dedupKey: syncAlertDedupKey(tenantId, row.platform, firstFailedRunId),
    };
  });
  report.candidates = candidates.length;

  for (const candidate of candidates) {
    try {
      const attempt = async (db?: SyncAlertQueryable): Promise<'sent' | 'deduped' | 'failed'> => {
        if (await deps.alreadySent(candidate.dedupKey, db)) return 'deduped';
        if (!await deps.send(candidate, db)) return 'failed';
        await deps.recordSent(candidate, db);
        return 'sent';
      };
      const outcome = deps.withCandidateLock
        ? await deps.withCandidateLock(candidate.dedupKey, attempt)
        : await attempt();
      if (outcome === 'sent') report.sent += 1;
      else if (outcome === 'failed') report.failed += 1;
      else report.deduped += 1;
    } catch (error) {
      report.failed += 1;
      console.error('[sync-failure-alerts] candidate failed', {
        tenantId: candidate.tenantId,
        platform: candidate.platform,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  return report;
}

/** Default dedupe helpers over `slack_notifications`, serialized per outage in Postgres. */
export function defaultDedupeDeps(
  pool: Pool,
): Pick<SyncAlertDeps, 'alreadySent' | 'recordSent' | 'withCandidateLock'> {
  return {
    async alreadySent(dedupKey, db = pool) {
      try {
        const res = await db.query(`SELECT 1 FROM slack_notifications WHERE dedup_key = $1`, [
          dedupKey,
        ]);
        return (res.rowCount ?? 0) > 0;
      } catch {
        // Fail-open, as the approval notifier does: a possible duplicate ping
        // beats a silent miss on a real outage.
        return false;
      }
    },
    async recordSent(candidate, db = pool) {
      await db.query(
        `INSERT INTO slack_notifications (dedup_key, kind, tenant_id, marketing_job_id)
         VALUES ($1, 'sync_failure', $2, $3)
         ON CONFLICT (dedup_key) DO NOTHING`,
        [candidate.dedupKey, candidate.tenantId, `sync:${candidate.platform}`],
      );
    },
    async withCandidateLock<T>(dedupKey: string, task: (db: SyncAlertQueryable) => Promise<T>) {
      const client = await pool.connect();
      let locked = false;
      let releaseError: Error | undefined;
      try {
        const result = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
          [dedupKey],
        );
        locked = result.rows[0]?.locked === true;
        return locked ? await task(client) : null;
      } finally {
        if (locked) {
          try {
            await client.query(
              'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
              [dedupKey],
            );
          } catch (error) {
            releaseError = error as Error;
          }
        }
        client.release(releaseError);
      }
    },
  };
}
