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
 * The streak definition is imported from the AA-116 read model rather than
 * restated, so the number that pages an operator and the number the sync-health
 * endpoint shows them are the same number by construction.
 */

import type { Pool } from 'pg';

import {
  currentFailureEpisode,
  type SyncRunRow,
  type SyncRunStatus,
} from '../sync-health/sync-health-logic';
import { classifySyncFailure } from '../sync-health/sync-health-logic';

export const DEFAULT_SYNC_FAILURE_ALERT_THRESHOLD = 3;
/** How many recent runs per (tenant, platform) the streak is computed over. */
export const SYNC_ALERT_RUN_WINDOW = 20;

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

/**
 * Recent terminal runs per (tenant, platform). Restart-aborts are fetched, not
 * filtered in SQL — the streak logic needs to SKIP them rather than have them
 * silently absent, which is a different thing (an absent row would let an older
 * success look adjacent to a newer failure).
 */
export const SYNC_ALERT_RUNS_SQL = `
  SELECT tenant_id, id, platform, status, error_message, started_at, finished_at
  FROM (
    SELECT
      r.tenant_id,
      r.id,
      r.platform,
      r.status,
      r.error_message,
      r.started_at,
      r.finished_at,
      ROW_NUMBER() OVER (
        PARTITION BY r.tenant_id, r.platform
        ORDER BY COALESCE(r.finished_at, r.started_at) DESC, r.id DESC
      ) AS rn
    FROM insights_sync_runs r
    WHERE r.started_at > now() - interval '7 days'
  ) ranked
  WHERE rn <= $1
  ORDER BY tenant_id, platform, rn
`;

export interface SyncAlertQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface SyncAlertCandidate {
  tenantId: number;
  platform: string;
  streak: number;
  firstFailedRunId: number;
  failureCategory: string;
  dedupKey: string;
}

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
    candidates.push({
      tenantId: first.tenantId,
      platform: first.platform,
      streak,
      firstFailedRunId,
      failureCategory: classifySyncFailure(first.errorMessage),
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
  send: (candidate: SyncAlertCandidate) => Promise<boolean>;
  /** Already-delivered check + record, keyed on the episode. */
  alreadySent: (dedupKey: string) => Promise<boolean>;
  recordSent: (candidate: SyncAlertCandidate) => Promise<void>;
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

  let rows: (SyncRunRow & { tenantId: number })[];
  try {
    const res = await deps.db.query<Record<string, unknown>>(SYNC_ALERT_RUNS_SQL, [
      SYNC_ALERT_RUN_WINDOW,
    ]);
    rows = res.rows.map((r) => ({
      tenantId: Number(r.tenant_id),
      id: Number(r.id),
      platform: String(r.platform ?? 'unknown'),
      trigger: 'interval',
      startedAt: String(r.started_at ?? ''),
      finishedAt: r.finished_at ? String(r.finished_at) : null,
      status: String(r.status ?? 'running') as SyncRunStatus,
      postsSeen: 0,
      commentsSeen: 0,
      apiUnitsUsed: 0,
      errorMessage: (r.error_message as string | null) ?? null,
    }));
  } catch (error) {
    console.error('[sync-failure-alerts] run scan failed', error);
    return report;
  }
  report.scanned = rows.length;

  const candidates = selectAlertCandidates(rows, syncFailureAlertThreshold(env));
  report.candidates = candidates.length;

  for (const candidate of candidates) {
    try {
      if (await deps.alreadySent(candidate.dedupKey)) {
        report.deduped += 1;
        continue;
      }
      const delivered = await deps.send(candidate);
      if (!delivered) {
        report.failed += 1;
        continue;
      }
      await deps.recordSent(candidate);
      report.sent += 1;
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

/** Default dedupe helpers over `slack_notifications`, matching the shipped kind pattern. */
export function defaultDedupeDeps(pool: Pool): Pick<SyncAlertDeps, 'alreadySent' | 'recordSent'> {
  return {
    async alreadySent(dedupKey) {
      try {
        const res = await pool.query(`SELECT 1 FROM slack_notifications WHERE dedup_key = $1`, [
          dedupKey,
        ]);
        return (res.rowCount ?? 0) > 0;
      } catch {
        // Fail-open, as the approval notifier does: a possible duplicate ping
        // beats a silent miss on a real outage.
        return false;
      }
    },
    async recordSent(candidate) {
      await pool
        .query(
          `INSERT INTO slack_notifications (dedup_key, kind, tenant_id, marketing_job_id)
           VALUES ($1, 'sync_failure', $2, $3)
           ON CONFLICT (dedup_key) DO NOTHING`,
          [candidate.dedupKey, candidate.tenantId, `sync:${candidate.platform}`],
        )
        .catch(() => {});
    },
  };
}
