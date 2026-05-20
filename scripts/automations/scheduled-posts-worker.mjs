/**
 * Scheduled-posts worker — drains the scheduled_posts table and fires
 * publishToMetaGraph for each row whose scheduled_for <= NOW() and
 * dispatch_status = 'pending'. Runs every minute via the cron manifest.
 */
import 'dotenv/config';

import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const INTERVAL_MS = 60 * 1000; // 1 minute
const BATCH_SIZE = 50;
const FETCH_TIMEOUT_MS = 30_000;

let running = false;
let intervalHandle = null;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function buildPool() {
  return new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: 3,
  });
}

// Claim SQL exported so a regression test can run it against a real schema
// without spinning up the whole worker. 'caption' is the canonical posts body
// column (see scripts/init-db.js) — selecting p.content here was schema drift.
export const CLAIM_ROW_SQL = `SELECT sp.id, sp.post_id, sp.tenant_id, sp.target_platforms,
            p.caption, p.platform_post_id
     FROM scheduled_posts sp
     LEFT JOIN posts p ON p.id = sp.post_id
     WHERE sp.id = $1
       AND sp.dispatch_status = 'pending'
     FOR UPDATE SKIP LOCKED`;

/**
 * Atomically claim a pending row (SELECT ... FOR UPDATE SKIP LOCKED) and
 * mark it as in-flight by setting dispatch_status = 'dispatched' optimistically.
 * Returns null if the row was already claimed by another instance.
 */
async function claimRow(client, rowId) {
  const lockResult = await client.query(CLAIM_ROW_SQL, [rowId]);
  if (lockResult.rows.length === 0) return null;
  return lockResult.rows[0];
}

async function markDispatched(client, rowId) {
  await client.query(
    `UPDATE scheduled_posts
     SET dispatch_status = 'dispatched', dispatched_at = now()
     WHERE id = $1`,
    [rowId],
  );
}

async function markFailed(client, rowId, errorMessage) {
  const truncated = String(errorMessage || 'unknown').slice(0, 1000);
  await client.query(
    `UPDATE scheduled_posts
     SET dispatch_status = 'failed', error_at = now(), error_message = $2
     WHERE id = $1`,
    [rowId, truncated],
  );
}

async function updatePostStatus(client, postId, status) {
  if (!postId) return;
  await client.query(
    `UPDATE posts SET published_status = $2, published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END
     WHERE id = $1`,
    [postId, status],
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function resolveAppBaseUrl() {
  return (process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || '').replace(/\/$/, '');
}

function resolveInternalSecret() {
  return process.env.INTERNAL_API_SECRET || '';
}

async function dispatchWithRetry(row, baseUrl, secret) {
  const platforms = Array.isArray(row.target_platforms) ? row.target_platforms : [];
  const content = row.caption || '';
  const tenantId = String(row.tenant_id);

  const url = `${baseUrl}/api/internal/publishing/scheduled-dispatch`;

  const body = JSON.stringify({
    tenant_id: tenantId,
    post_id: String(row.post_id),
    platforms,
    content,
  });

  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${secret}`,
  };

  async function attempt() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  // First attempt
  let res;
  try {
    res = await attempt();
  } catch (error) {
    // Transient network / timeout: retry once
    try {
      res = await attempt();
    } catch (retryError) {
      throw new Error(`fetch failed after retry: ${String((retryError).message || retryError)}`);
    }
  }

  if (res.ok || res.status === 202) return res;

  // 4xx: don't retry (bad token, page deleted, etc.)
  if (res.status >= 400 && res.status < 500) {
    const body2 = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`dispatch 4xx: ${res.status} ${body2.slice(0, 200)}`),
      { retryable: false },
    );
  }

  // 5xx: retry once
  try {
    res = await attempt();
  } catch (retryError) {
    throw new Error(`fetch 5xx retry failed: ${String((retryError).message || retryError)}`);
  }

  if (!res.ok && res.status !== 202) {
    const body2 = await res.text().catch(() => '');
    throw new Error(`dispatch failed after retry: ${res.status} ${body2.slice(0, 200)}`);
  }

  return res;
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

async function tick(pool) {
  const baseUrl = resolveAppBaseUrl();
  const secret = resolveInternalSecret();

  if (!baseUrl) {
    console.error('[scheduled-posts-worker] APP_BASE_URL not set; skipping tick');
    return { processed: 0, dispatched: 0, failed: 0, skipped: 0 };
  }

  // Fetch due rows
  const dueResult = await pool.query(
    `SELECT id FROM scheduled_posts
     WHERE scheduled_for <= NOW()
       AND dispatch_status = 'pending'
     ORDER BY scheduled_for
     LIMIT $1`,
    [BATCH_SIZE],
  );

  const ids = dueResult.rows.map((r) => r.id);
  const report = { processed: ids.length, dispatched: 0, failed: 0, skipped: 0 };

  for (const rowId of ids) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const row = await claimRow(client, rowId);
      if (!row) {
        report.skipped += 1;
        await client.query('ROLLBACK');
        continue;
      }

      // Optimistically mark dispatched inside the transaction to prevent
      // double-dispatch if another worker instance picks the same row.
      await markDispatched(client, rowId);
      await client.query('COMMIT');

      // Fire the dispatch outside the transaction (network call)
      try {
        await dispatchWithRetry(row, baseUrl, secret);
        await updatePostStatus(client, row.post_id, 'published');
        report.dispatched += 1;
      } catch (dispatchError) {
        const isRetryable = dispatchError.retryable !== false;
        const errMsg = String(dispatchError.message || dispatchError);
        console.error(`[scheduled-posts-worker] dispatch failed row=${rowId}`, errMsg);

        if (!isRetryable) {
          // Hard failure: mark failed permanently
          const fc = await pool.connect();
          try {
            await markFailed(fc, rowId, errMsg);
            await updatePostStatus(fc, row.post_id, 'failed');
          } finally {
            fc.release();
          }
        } else {
          // Retryable: reset to pending so the next tick can retry
          const fc = await pool.connect();
          try {
            await fc.query(
              `UPDATE scheduled_posts SET dispatch_status = 'pending' WHERE id = $1`,
              [rowId],
            );
          } finally {
            fc.release();
          }
        }

        report.failed += 1;
      }
    } catch (rowError) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      console.error(`[scheduled-posts-worker] row error id=${rowId}`, rowError);
      report.failed += 1;
    } finally {
      client.release();
    }
  }

  return report;
}

async function tickSafe(pool) {
  if (running) {
    console.warn('[scheduled-posts-worker] previous tick still running; skipping');
    return;
  }
  running = true;
  try {
    const report = await tick(pool);
    if (report.processed > 0 || report.failed > 0) {
      console.log(
        `[scheduled-posts-worker] summary ${JSON.stringify(report)}`,
      );
    }
  } catch (error) {
    console.error('[scheduled-posts-worker] tick error', error);
  } finally {
    running = false;
  }
}

async function main() {
  const pool = buildPool();

  console.log(`[scheduled-posts-worker] starting; interval=${INTERVAL_MS}ms batch=${BATCH_SIZE}`);

  await tickSafe(pool);

  if (process.env.ARIES_SCHEDULED_POSTS_RUN_ONCE?.trim() === '1') {
    await pool.end();
    process.exit(0);
  }

  intervalHandle = setInterval(() => void tickSafe(pool), INTERVAL_MS);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      if (intervalHandle) clearInterval(intervalHandle);
      await pool.end().catch(() => {});
      process.exit(0);
    });
  }
}

// Only auto-start when run directly as a script; importing this module (e.g.
// from a regression test for CLAIM_ROW_SQL) must not spin up the worker loop.
const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  void main();
}
