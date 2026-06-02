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
import pool from '@/lib/db';
import { syncAllAccountsForTenant } from '@/backend/insights/sync/dispatcher';

// ── Config ────────────────────────────────────────────────────────────────────

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ── State ─────────────────────────────────────────────────────────────────────

/** Prevents overlapping ticks if one sync run takes longer than the interval. */
let ticking = false;

// ── Core tick ─────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (ticking) {
    log({ event: 'insights_sync_skip', reason: 'previous_tick_still_running' });
    return;
  }
  ticking = true;

  // Load all tenants that have at least one connected insights account
  const client = await pool.connect();
  let tenantIds: number[] = [];
  try {
    const res = await client.query<{ tenant_id: number }>(
      `SELECT DISTINCT tenant_id FROM insights_accounts ORDER BY tenant_id`,
    );
    tenantIds = res.rows.map((r) => r.tenant_id);
  } finally {
    client.release();
  }

  if (tenantIds.length === 0) {
    log({ event: 'insights_sync_noop', reason: 'no_connected_accounts' });
    ticking = false;
    return;
  }

  log({ event: 'insights_sync_start', tenants: tenantIds.length, tenantIds });

  let totalOk = 0;
  let totalFailed = 0;

  for (const tenantId of tenantIds) {
    const results = await syncAllAccountsForTenant(tenantId, 'interval');

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
    accountsOk:  totalOk,
    accountsFailed: totalFailed,
  });

  ticking = false;
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

// ── Startup ───────────────────────────────────────────────────────────────────

log({ event: 'insights_sync_worker_start', intervalMs: INTERVAL_MS });

// Run the first tick immediately on startup, then every INTERVAL_MS
tick().catch((err) => {
  log({ event: 'insights_sync_fatal', error: String(err) });
});

const intervalHandle = setInterval(() => {
  tick().catch((err) => {
    log({ event: 'insights_sync_fatal', error: String(err) });
  });
}, INTERVAL_MS);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  log({ event: 'insights_sync_worker_shutdown', signal });
  clearInterval(intervalHandle);
  pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
