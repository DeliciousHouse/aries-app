/**
 * Composio connection reconciler — standing process that sweeps pending
 * connected_accounts rows and calls refreshConnectionStatus so a Composio
 * INITIALIZING→ACTIVE transition (which can take several minutes) is reflected
 * in the DB without any operator action.
 *
 * Problem: the connections dashboard polls for ~30s after an OAuth return, but
 * Composio can take up to ~9 minutes to activate a connection. After that
 * window the user sees "not connected" forever unless they manually refresh or
 * re-open the page. This worker closes that gap by re-checking all pending rows
 * (updated within GRACE_MINUTES) every INTERVAL_MS.
 *
 * Gated by ARIES_COMPOSIO_RECONCILER_ENABLED (default OFF). When off the
 * container idles cleanly (no restart loop), exactly like the draft-expiry
 * worker. Mirrors the structure of draft-expiry-sweep-worker.ts.
 *
 * Safety:
 *   - default OFF; ships dormant.
 *   - GRACE_MINUTES-bounded query so only recently-pending rows are swept.
 *   - Per-row errors are isolated; never throws from the tick loop.
 *   - One-line log summary only when scanned > 0.
 */
import 'dotenv/config';

import pg from 'pg';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  reconcilePendingConnections,
  DEFAULT_RECONCILE_GRACE_MINUTES,
} from '@/backend/integrations/composio/reconcile-pending-connections';
import { parsePoolMax, WORKER_POOL_MAX } from '@/lib/db-pool-config';

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ARIES_COMPOSIO_RECONCILER_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function resolveIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const DEFAULT = 60_000;
  const raw = parseInt(env.ARIES_COMPOSIO_RECONCILER_INTERVAL_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT;
}

function resolveGraceMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.ARIES_COMPOSIO_RECONCILER_GRACE_MINUTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECONCILE_GRACE_MINUTES;
}

// ---------------------------------------------------------------------------
// DB pool
// ---------------------------------------------------------------------------

export function buildPool(): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: parsePoolMax(process.env.DB_POOL_MAX, WORKER_POOL_MAX),
  });
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let running = false;
let intervalHandle: NodeJS.Timeout | null = null;

async function tickSafe(pool: pg.Pool): Promise<void> {
  if (running) {
    console.warn('[composio-connection-reconciler-worker] previous tick still running; skipping');
    return;
  }
  running = true;
  try {
    const graceMinutes = resolveGraceMinutes();
    const summary = await reconcilePendingConnections({ db: pool, graceMinutes });
    if (summary.scanned > 0) {
      console.log(
        `[composio-connection-reconciler-worker] tick summary ${JSON.stringify(summary)}`,
      );
    }
  } catch (err) {
    console.error('[composio-connection-reconciler-worker] tick error', err);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  if (!isEnabled()) {
    // IDLE, do not exit. This runs as a docker-compose service with
    // `restart: unless-stopped`; a clean exit(0) makes Docker restart-loop
    // the container. Staying alive doing nothing leaves it cleanly "up" when
    // the flag is off, while still responding to `docker stop`. Set the flag
    // and restart the service to enable. (Same pattern as draft-expiry worker.)
    console.log(
      '[composio-connection-reconciler-worker] ARIES_COMPOSIO_RECONCILER_ENABLED is off; idling (no work). Set the flag and restart to enable.',
    );
    if (process.env.ARIES_COMPOSIO_RECONCILER_RUN_ONCE?.trim() === '1') {
      process.exit(0); // one-shot / smoke invocations must not hang
    }
    const idle = setInterval(() => {}, 1 << 30); // keeps the event loop alive
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        clearInterval(idle);
        process.exit(0);
      });
    }
    return;
  }

  const intervalMs = resolveIntervalMs();
  const graceMinutes = resolveGraceMinutes();
  const pool = buildPool();
  console.log(
    `[composio-connection-reconciler-worker] starting; interval=${intervalMs}ms grace_minutes=${graceMinutes}`,
  );

  await tickSafe(pool);

  if (process.env.ARIES_COMPOSIO_RECONCILER_RUN_ONCE?.trim() === '1') {
    await pool.end();
    process.exit(0);
  }

  intervalHandle = setInterval(() => void tickSafe(pool), intervalMs);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      if (intervalHandle) clearInterval(intervalHandle);
      await pool.end().catch(() => {});
      process.exit(0);
    });
  }
}

// Only auto-start when run directly; importing this module (e.g. from a unit
// test for buildPool) must not spin up the worker loop.
const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  void main();
}
