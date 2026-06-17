/**
 * scripts/automations/insights-sync-worker.ts
 *
 * Long-lived sidecar that syncs platform analytics for every tenant that has
 * at least one connected insights_account. Runs every 30 minutes.
 *
 * Follows the same pattern as scheduled-posts-worker.mjs:
 *   - Single replica in docker-compose (avoids duplicate API calls / DB writes)
 *   - Self-schedules via setInterval
 *   - All output is newline-delimited JSON for log aggregators
 *   - Graceful shutdown on SIGTERM / SIGINT
 *
 * Run locally:
 *   DB_HOST=localhost DB_PORT=5432 DB_USER=aries_user DB_PASSWORD=aries_pass \
 *   DB_NAME=aries_dev node_modules/.bin/tsx scripts/automations/insights-sync-worker.ts
 *
 * In Docker: started automatically via the aries-insights-sync-worker service
 * in docker-compose.yml (depends on aries-app being healthy).
 *
 * During Phase 3 (adapter stubs): every sync will record status='failed' with
 * "not implemented". That is expected — the seeded data in the DB is untouched
 * and the analytics read-path works normally. Failed sync runs are visible in
 * insights_sync_runs for debugging.
 */

import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pool from '@/lib/db';
import { syncAllAccountsForTenant } from '@/backend/insights/sync/dispatcher';
import { sweepAbandonedSyncRuns } from '@/backend/insights/sync/sweep-stranded-runs';
import { ensureInsightsAccountsForConnectedPlatforms } from '@/backend/insights/sync/ensure-account';
import type { Queryable } from '@/backend/integrations/composio/connection-store';

// ── Config ────────────────────────────────────────────────────────────────────

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ── State ─────────────────────────────────────────────────────────────────────

/** Prevents overlapping ticks if one sync run takes longer than the interval. */
let ticking = false;

// ── Core tick ─────────────────────────────────────────────────────────────────

/**
 * Minimal pool surface the tick needs. Lets the regression tests
 * (tests/insights-sync-worker-tick-reset.test.ts,
 * tests/insights-sync-worker-stranded-runs.test.ts) drive tickSafe against an
 * in-memory fake; the real `pg` Pool satisfies it structurally.
 *
 * Note: this only covers the tenant-list query and the stranded-run sweep.
 * The default syncFn (syncAllAccountsForTenant) uses the global `@/lib/db`
 * pool internally, so a test injecting a fake pool must inject a fake syncFn
 * too.
 */
export type TickPool = {
  connect(): Promise<{
    query(sql: string): Promise<{
      rows: Array<{ tenant_id: number }>;
      rowCount?: number | null;
    }>;
    release(): void;
  }>;
};

/** Injectable per-tenant sync, so tests can exercise the fan-out loop. */
export type SyncAllAccountsFn = typeof syncAllAccountsForTenant;

async function tick(dbPool: TickPool, syncFn: SyncAllAccountsFn): Promise<void> {
  // Sweep stranded runs before syncing; a sweep failure must not cost the
  // tenants their 30-minute sync window.
  try {
    const swept = await sweepAbandonedSyncRuns(dbPool);
    if (swept > 0) log({ event: 'insights_sync_stranded_runs_swept', count: swept });
  } catch (err) {
    log({ event: 'insights_sync_sweep_failed', error: describeError(err) });
  }

  // Load all tenants that have at least one connected insights account
  const client = await dbPool.connect();
  let tenantIds: number[] = [];
  try {
    const res = await client.query(
      `SELECT DISTINCT tenant_id FROM insights_accounts ORDER BY tenant_id`,
    );
    tenantIds = res.rows.map((r) => r.tenant_id);
  } finally {
    client.release();
  }

  if (tenantIds.length === 0) {
    log({ event: 'insights_sync_noop', reason: 'no_connected_accounts' });
    return;
  }

  log({ event: 'insights_sync_start', tenants: tenantIds.length, tenantIds });

  let totalOk = 0;
  let totalFailed = 0;
  let tenantsFailed = 0;

  for (const tenantId of tenantIds) {
    // Per-tenant isolation: one tenant's sync blowing up (its own pool.connect,
    // the account-list query, an adapter bug) must not starve the remaining
    // tenants until the next 30-minute interval.
    let results: Awaited<ReturnType<SyncAllAccountsFn>>;
    try {
      results = await syncFn(tenantId, 'interval');
    } catch (err) {
      tenantsFailed++;
      log({ event: 'insights_sync_tenant_failed', tenantId, error: describeError(err) });
      continue;
    }

    for (const r of results) {
      const entry: Record<string, unknown> = {
        event:        'insights_sync_account',
        tenantId,
        accountId:    r.accountId,
        platform:     r.platform,
        status:       r.status,
        postsSeen:    r.postsSeen,
        commentsSeen: r.commentsSeen,
        apiUnitsUsed: r.apiUnitsUsed,
        syncRunId:    r.syncRunId,
      };
      if (r.errorMessage) entry['error'] = r.errorMessage;
      log(entry);

      if (r.status === 'ok') totalOk++;
      else totalFailed++;
    }
  }

  log({
    event:       'insights_sync_done',
    tenants:     tenantIds.length,
    tenantsFailed,
    accountsOk:  totalOk,
    accountsFailed: totalFailed,
  });
}

/**
 * Overlap-guarded tick, same shape as the other sidecar workers. `ticking` is
 * reset in `finally` — a tick that throws (e.g. ECONNREFUSED on the first tick
 * while Postgres is still starting) must never wedge the guard, or every later
 * tick skips with `previous_tick_still_running` until the container restarts.
 */
export async function tickSafe(
  dbPool: TickPool,
  syncFn: SyncAllAccountsFn = syncAllAccountsForTenant,
): Promise<void> {
  if (ticking) {
    log({ event: 'insights_sync_skip', reason: 'previous_tick_still_running' });
    return;
  }
  ticking = true;
  try {
    await tick(dbPool, syncFn);
  } catch (err) {
    log({ event: 'insights_sync_fatal', error: describeError(err) });
  } finally {
    ticking = false;
  }
}

/**
 * Project connected Composio accounts into insights_accounts, then run a sync
 * tick. The bridge is best-effort and isolated: nothing populates
 * insights_accounts otherwise (so the sync would no-op), but a bridge failure
 * must never cost the existing accounts their sync window.
 */
export async function bridgeAndTick(
  dbPool: TickPool & Queryable = pool,
  syncFn: SyncAllAccountsFn = syncAllAccountsForTenant,
): Promise<void> {
  try {
    // Pass the SAME pool the tick uses — so a test injecting a fake pool never
    // silently reaches the real database through the bridge.
    const res = await ensureInsightsAccountsForConnectedPlatforms(dbPool);
    if (res.upserted > 0 || res.resolved > 0 || res.skippedNoPage > 0) {
      log({
        event: 'insights_sync_accounts_bridged',
        upserted: res.upserted,
        considered: res.considered,
        resolved: res.resolved,
        skippedNoPage: res.skippedNoPage,
      });
    }
  } catch (err) {
    log({ event: 'insights_sync_bridge_failed', error: describeError(err) });
  }
  await tickSafe(dbPool, syncFn);
}

/** Keep the stack when there is one — `String(err)` drops it. */
function describeError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

// ── Startup ───────────────────────────────────────────────────────────────────

function main(): void {
  log({ event: 'insights_sync_worker_start', intervalMs: INTERVAL_MS });

  // Run the first tick immediately on startup, then every INTERVAL_MS.
  // bridgeAndTick first projects connected Composio accounts into
  // insights_accounts (otherwise the sync no-ops), then runs tickSafe — which
  // never rejects: failures are logged as insights_sync_fatal and the overlap
  // guard is released so the next interval retries.
  void bridgeAndTick(pool);

  const intervalHandle = setInterval(() => void bridgeAndTick(pool), INTERVAL_MS);

  // ── Graceful shutdown ───────────────────────────────────────────────────────

  function shutdown(signal: string): void {
    log({ event: 'insights_sync_worker_shutdown', signal });
    clearInterval(intervalHandle);
    pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// Only auto-start when run directly as a script; importing this module (e.g.
// from the tick-reset regression test) must not spin up the worker loop.
const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main();
}
