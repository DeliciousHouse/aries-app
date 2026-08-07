/**
 * scripts/insights-sync-alert-worker.ts
 *
 * S6-4 / AA-117 (gap F4b) — the sync-failure alert tick.
 *
 * SPAWNED BY scripts/start-runtime.mjs, i.e. it runs INSIDE the aries-app
 * container. That placement is the whole point of the card: the Slack env
 * (ARIES_SLACK_NOTIFICATIONS_ENABLED, SLACK_*, OAUTH_TOKEN_ENCRYPTION_KEY) is
 * scoped to the `aries-app` service, so this is the only place a Slack send can
 * actually resolve a tenant's workspace and post. Running the same logic from
 * `aries-insights-sync-worker` would resolve no config and return "skipped"
 * without erroring — a silent no-op that looks healthy.
 *
 * Mirrors the Hermes reconciler's shape: a self-scheduling setInterval with an
 * overlap guard released in `finally`, so one slow tick cannot stack.
 *
 * Gated by ARIES_SYNC_FAILURE_ALERT_ENABLED (default OFF) — with the gate off it
 * exits to idle rather than spinning, matching the dormant-sidecar pattern.
 */

import 'dotenv/config';

import { Pool } from 'pg';

import {
  defaultDedupeDeps,
  isSyncFailureAlertEnabled,
  runSyncFailureAlertSweep,
  syncFailureAlertThreshold,
} from '@/backend/insights/sync-alerts/sync-failure-alerts';
import { notifySyncFailure } from '@/backend/insights/sync-alerts/notify-sync-failure';
import { parsePoolMax, WORKER_POOL_MAX } from '@/lib/db-pool-config';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export function alertIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ARIES_SYNC_FAILURE_ALERT_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

let running = false;

async function tickSafe(pool: Pool): Promise<void> {
  if (running) {
    console.warn('[sync-failure-alerts] previous tick still running; skipping');
    return;
  }
  running = true;
  try {
    const report = await runSyncFailureAlertSweep({
      db: pool,
      send: (candidate, db) => notifySyncFailure(candidate, { pool: (db ?? pool) as typeof pool }),
      ...defaultDedupeDeps(pool),
    });
    if (report.candidates > 0 || report.failed > 0) {
      console.log(`[sync-failure-alerts] ${JSON.stringify(report)}`);
    }
  } catch (error) {
    console.error('[sync-failure-alerts] tick error', error);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  if (!isSyncFailureAlertEnabled()) {
    console.log('[sync-failure-alerts] disabled (ARIES_SYNC_FAILURE_ALERT_ENABLED); idling');
    return;
  }

  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: parsePoolMax(process.env.DB_POOL_MAX, WORKER_POOL_MAX),
  });

  const interval = alertIntervalMs();
  console.log(
    `[sync-failure-alerts] starting; interval=${interval}ms threshold=${syncFailureAlertThreshold()}`,
  );

  await tickSafe(pool);
  if (process.env.ARIES_SYNC_ALERT_RUN_ONCE?.trim() === '1') {
    await pool.end();
    return;
  }

  const handle = setInterval(() => void tickSafe(pool), interval);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      clearInterval(handle);
      await pool.end().catch(() => {});
      process.exit(0);
    });
  }
}

void main();
