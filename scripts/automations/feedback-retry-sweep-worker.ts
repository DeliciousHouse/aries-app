/**
 * Feedback retry-sweep worker — standing process that heals customer incident
 * reports whose Jira delivery is incomplete (SC-70 port): parked pending_retry
 * rows, attach-only completions, and stale 'pending' rows stranded by a crash.
 *
 * Mirrors the draft-expiry / weekly-trigger workers: a single-replica
 * docker-compose service, self-scheduling on an interval, talking only to its
 * own Postgres pool. The sweep logic lives in backend/feedback/retry-sweep.ts;
 * this file is just the loop + config + logging.
 *
 * Gating: ARIES_FEEDBACK_RETRY_ENABLED (default ON — unlike the other sidecars
 * this one is inherently dormant without JIRA_* config: it idles with one info
 * line and touches nothing, and default-on is what lets parked rows heal the
 * moment config lands). When the flag is explicitly off the container idles
 * cleanly (no restart loop), exactly like the draft-expiry worker.
 */
import 'dotenv/config';

import pg from 'pg';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  feedbackRetryWorkerEnabled,
  resolveFeedbackReportConfig,
} from '@/backend/feedback/report-config';
import { runFeedbackRetrySweep } from '@/backend/feedback/retry-sweep';
import { parsePoolMax, WORKER_POOL_MAX } from '@/lib/db-pool-config';

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

let running = false;
let intervalHandle: NodeJS.Timeout | null = null;

async function tickSafe(pool: pg.Pool): Promise<void> {
  if (running) {
    console.warn('[feedback-retry-worker] previous tick still running; skipping');
    return;
  }
  running = true;
  try {
    // Config re-resolves per tick so a container restarted with fresh JIRA_*
    // env goes from parked to healing without code changes.
    const config = resolveFeedbackReportConfig();
    const report = await runFeedbackRetrySweep(pool, config, {});
    if (report.claimed > 0 || report.errors > 0) {
      console.log(`[feedback-retry-worker] summary ${JSON.stringify(report)}`);
    }
  } catch (error) {
    console.error('[feedback-retry-worker] tick error', error);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  if (!feedbackRetryWorkerEnabled()) {
    // IDLE, do not exit: a clean exit(0) under restart: unless-stopped makes
    // Docker restart-loop the container (same rationale as the draft-expiry
    // worker's main()).
    console.log(
      '[feedback-retry-worker] ARIES_FEEDBACK_RETRY_ENABLED is off; idling (no work). Set the flag and restart to enable.',
    );
    if (process.env.ARIES_FEEDBACK_RETRY_RUN_ONCE?.trim() === '1') {
      process.exit(0); // one-shot / smoke invocations must not hang
    }
    const idle = setInterval(() => {}, 1 << 30);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        clearInterval(idle);
        process.exit(0);
      });
    }
    return;
  }

  const config = resolveFeedbackReportConfig();
  const intervalMs = config.retryIntervalMinutes * 60_000;
  const pool = buildPool();
  console.log(
    `[feedback-retry-worker] starting; interval=${intervalMs}ms batch=${config.retryBatchLimit} max_attempts=${config.retryMaxAttempts} jira_configured=${config.jira !== null}`,
  );

  await tickSafe(pool);

  if (process.env.ARIES_FEEDBACK_RETRY_RUN_ONCE?.trim() === '1') {
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
