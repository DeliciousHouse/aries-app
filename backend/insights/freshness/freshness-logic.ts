/**
 * backend/insights/freshness/freshness-logic.ts
 *
 * Pure status logic for the /insights data-freshness stamp (S1-3 / AA-82).
 * No DB, no I/O — testable in isolation.
 *
 * The stamp must let a user tell "the sync broke / data is stale" apart from
 * "my engagement is genuinely flat". So it is derived from insights_sync_runs
 * STATUS + finished_at (NOT insights_accounts.last_sync_at alone, which is set
 * on both ok AND partial runs and is not updated on a failed run — it can't
 * distinguish fresh from partial/failed).
 *
 * Multi-account rule: the stamp reflects the LEAST-fresh connected account
 * (oldest successful sync), so it never implies everything is fresh when one
 * channel is stale or has never synced.
 *
 * Precedence (worst wins): never_synced → stale → partial → fresh.
 */

export type FreshnessStatus = 'fresh' | 'partial' | 'stale' | 'never_synced';

/** Per-account sync state (one row per connected insights_account). */
export interface AccountSyncRow {
  platform:      string;
  displayName:   string | null;
  /** Status of the account's most recent TERMINAL run (ok|partial|failed), or null if none. */
  latestStatus:  'ok' | 'partial' | 'failed' | null;
  /** finished_at of the account's most recent ok|partial run (the "data as of"), or null. */
  lastSuccessAt: string | Date | null;
}

export interface FreshnessAccount {
  platform:      string;
  displayName:   string | null;
  lastSuccessAt: string | null;
  latestStatus:  string | null;
}

export interface FreshnessResult {
  status:                FreshnessStatus;
  /** ISO timestamp of the least-fresh successful sync across accounts; null if never synced. */
  dataAsOf:              string | null;
  staleThresholdMinutes: number;
  accounts:              FreshnessAccount[];
}

function toIso(value: string | Date | null): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function computeFreshness(rows: AccountSyncRow[], now: Date, staleMs: number): FreshnessResult {
  const staleThresholdMinutes = Math.round(staleMs / 60000);

  const accounts: FreshnessAccount[] = rows.map((r) => ({
    platform:      r.platform,
    displayName:   r.displayName,
    lastSuccessAt: toIso(r.lastSuccessAt),
    latestStatus:  r.latestStatus,
  }));

  const successMs = accounts
    .map((a) => (a.lastSuccessAt ? new Date(a.lastSuccessAt).getTime() : null))
    .filter((n): n is number => n !== null);

  // No connected accounts, or none has ever completed an ok|partial run.
  if (accounts.length === 0 || successMs.length === 0) {
    return { status: 'never_synced', dataAsOf: null, staleThresholdMinutes, accounts };
  }

  // Least-fresh successful sync = the stamp's "data as of".
  const oldestSuccessMs = Math.min(...successMs);
  const dataAsOf = new Date(oldestSuccessMs).toISOString();

  const anyFailed      = accounts.some((a) => a.latestStatus === 'failed');
  const anyNeverSynced = accounts.some((a) => a.lastSuccessAt === null); // a connected account with no success yet
  const ageExceeded    = now.getTime() - oldestSuccessMs > staleMs;

  // stale = the "sync broke / data is old" signal — a visible warning, never a
  // silent fresh-looking stamp.
  if (ageExceeded || anyFailed || anyNeverSynced) {
    return { status: 'stale', dataAsOf, staleThresholdMinutes, accounts };
  }

  // partial = fresh enough, but some legs of the latest run failed — must not
  // claim fully-fresh data.
  const anyPartial = accounts.some((a) => a.latestStatus === 'partial');
  return { status: anyPartial ? 'partial' : 'fresh', dataAsOf, staleThresholdMinutes, accounts };
}
