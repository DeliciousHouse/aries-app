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
// A row claimed as 'in_flight' but not driven to a terminal state within this
// window is assumed to belong to a crashed worker pass and is re-claimable.
// Comfortably larger than one fetch timeout so a slow-but-live publish is not
// stolen mid-flight.
const IN_FLIGHT_RECLAIM_MS = 10 * 60 * 1000; // 10 minutes

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
// A row is claimable when it is 'pending', OR when it is 'in_flight' but has
// been stuck past IN_FLIGHT_RECLAIM_MS (its worker pass crashed before
// publish confirmed). $2 is the stale-in_flight cutoff timestamp.
// The lock is `FOR UPDATE OF sp` — not a bare `FOR UPDATE` — because Postgres
// rejects row locks on the nullable side of a LEFT JOIN; `posts` is read-only
// enrichment here, only the `scheduled_posts` row is being claimed.
// Event-campaign auto-stop: rows whose parent campaign has ended
// (campaign_end_date < NOW()) are excluded at claim time. NULL means "no end
// date" — the legacy weekly_social_content behaviour, never blocked. In-flight
// rows that crossed the deadline after being claimed run to completion (the
// claim-time filter is the only enforcement point; once Meta has been called
// we cannot un-call it).
export const CLAIM_ROW_SQL = `SELECT sp.id, sp.post_id, sp.tenant_id, sp.target_platforms,
            p.caption, p.platform_post_id
     FROM scheduled_posts sp
     LEFT JOIN posts p ON p.id = sp.post_id
     WHERE sp.id = $1
       AND (
         sp.dispatch_status = 'pending'
         OR (sp.dispatch_status = 'in_flight' AND sp.updated_at < $2)
       )
       AND (sp.campaign_end_date IS NULL OR sp.campaign_end_date >= NOW())
     FOR UPDATE OF sp SKIP LOCKED`;

// Due-rows scan, exported alongside CLAIM_ROW_SQL so a regression test runs the
// real query against a real planner. $1 is the batch size, $2 the
// stale-in_flight cutoff timestamp. Same campaign_end_date filter as
// CLAIM_ROW_SQL — defense in depth, and lets the planner skip past-deadline
// rows before they reach the per-row claim transaction.
export const DUE_ROWS_SQL = `SELECT id FROM scheduled_posts
     WHERE scheduled_for <= NOW()
       AND (
         dispatch_status = 'pending'
         OR (dispatch_status = 'in_flight' AND updated_at < $2)
       )
       AND (campaign_end_date IS NULL OR campaign_end_date >= NOW())
     ORDER BY scheduled_for
     LIMIT $1`;

// Parent-row claim UPDATE, exported for the same regression-test reason. $1 is
// the scheduled_posts id.
export const MARK_IN_FLIGHT_SQL = `UPDATE scheduled_posts
     SET dispatch_status = 'in_flight', updated_at = now()
     WHERE id = $1`;

/**
 * Atomically claim a row (SELECT ... FOR UPDATE SKIP LOCKED). Picks pending
 * rows and stale 'in_flight' rows whose worker pass crashed. Returns null if
 * the row was already claimed by another instance or is not (re)claimable.
 */
async function claimRow(client, rowId) {
  const staleCutoff = new Date(Date.now() - IN_FLIGHT_RECLAIM_MS).toISOString();
  const lockResult = await client.query(CLAIM_ROW_SQL, [rowId, staleCutoff]);
  if (lockResult.rows.length === 0) return null;
  return lockResult.rows[0];
}

/**
 * Mark the parent row 'in_flight': a non-terminal claimed state committed
 * BEFORE the network publish runs. A crash after this commit leaves a
 * reclaimable row, never a false 'dispatched'. `updated_at` is bumped so the
 * stale-reclaim window is measured from the claim.
 */
async function markInFlight(client, rowId) {
  await client.query(MARK_IN_FLIGHT_SQL, [rowId]);
}

// --- Per-platform dispatch state ------------------------------------------

/**
 * Roll a set of per-platform statuses up into the single parent
 * scheduled_posts.dispatch_status. A row is only 'dispatched' once every
 * platform succeeded; 'failed' once every platform reached a terminal state
 * and at least one failed; otherwise it stays non-terminal ('in_flight' if
 * any platform is in flight, else 'pending') so a later pass re-claims it.
 */
export function rollupParentStatus(platformStatuses) {
  const statuses = Array.isArray(platformStatuses) ? platformStatuses : [];
  if (statuses.length === 0) return 'pending';
  if (statuses.every((s) => s === 'dispatched')) return 'dispatched';
  if (statuses.every((s) => s === 'dispatched' || s === 'failed')) return 'failed';
  if (statuses.some((s) => s === 'in_flight')) return 'in_flight';
  return 'pending';
}

/**
 * Seed one scheduled_post_dispatches row per target platform in the
 * non-terminal 'in_flight' state, committed before the publish runs. On a
 * re-claim of a stale row, a child already 'dispatched' is left untouched so a
 * platform that already went live is never re-sent; only non-terminal children
 * are reset to 'in_flight' for the retry.
 */
async function seedPlatformDispatches(client, rowId, platforms) {
  if (platforms.length === 0) return;
  // One multi-row INSERT instead of one round-trip per platform. $1 is the
  // scheduled_post id; $2.. are the platform names. ON CONFLICT keeps the
  // re-claim semantics: a child already terminal ('dispatched'/'failed') is
  // left untouched, only a non-terminal child is reset to 'in_flight'.
  const valueTuples = platforms
    .map((_, i) => `($1, $${i + 2}, 'in_flight', now())`)
    .join(', ');
  await client.query(
    `INSERT INTO scheduled_post_dispatches (scheduled_post_id, platform, status, updated_at)
     VALUES ${valueTuples}
     ON CONFLICT (scheduled_post_id, platform) DO UPDATE
       SET status = 'in_flight', updated_at = now()
       WHERE scheduled_post_dispatches.status IN ('pending', 'in_flight')`,
    [rowId, ...platforms],
  );
}

/** Set a single platform's child-row status (with optional error detail). */
async function setPlatformDispatchStatus(client, rowId, platform, status, errorMessage) {
  const truncated = errorMessage ? String(errorMessage).slice(0, 1000) : null;
  await client.query(
    `UPDATE scheduled_post_dispatches
     SET status = $3,
         dispatched_at = CASE WHEN $3 = 'dispatched' THEN now() ELSE dispatched_at END,
         error_at = CASE WHEN $3 = 'failed' THEN now() ELSE error_at END,
         error_message = CASE WHEN $3 = 'failed' THEN $4 ELSE error_message END,
         updated_at = now()
     WHERE scheduled_post_id = $1 AND platform = $2`,
    [rowId, platform, status, truncated],
  );
}

/** Recompute and persist the parent rollup from the child rows. */
async function syncParentRollup(client, rowId) {
  const childResult = await client.query(
    `SELECT status, error_message FROM scheduled_post_dispatches WHERE scheduled_post_id = $1`,
    [rowId],
  );
  const statuses = childResult.rows.map((r) => r.status);
  const rolled = rollupParentStatus(statuses);
  const firstError = childResult.rows.find((r) => r.status === 'failed' && r.error_message)?.error_message ?? null;
  await client.query(
    `UPDATE scheduled_posts
     SET dispatch_status = $2,
         dispatched_at = CASE WHEN $2 = 'dispatched' THEN now() ELSE dispatched_at END,
         error_at = CASE WHEN $2 = 'failed' THEN now() ELSE error_at END,
         error_message = CASE WHEN $2 = 'failed' THEN $3 ELSE error_message END
     WHERE id = $1`,
    [rowId, rolled, firstError],
  );
  return rolled;
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

/**
 * Normalize a per-platform `results` array from the dispatch route into the
 * per-platform child-row outcome the worker persists. A platform with `ok`
 * becomes 'dispatched'; a non-retryable failure becomes terminal 'failed'; a
 * retryable failure stays 'pending' so the next worker pass re-claims it.
 * `transportError` covers the case where the whole dispatch call failed (no
 * per-platform breakdown available) — every requested platform stays retryable.
 */
export function planPlatformOutcomes(platforms, results, transportError) {
  const list = Array.isArray(platforms) ? platforms : [];
  const byProvider = new Map(
    (Array.isArray(results) ? results : []).map((r) => [r.provider, r]),
  );
  return list.map((platform) => {
    if (transportError) {
      return { platform, status: 'pending', error: transportError, retryable: true };
    }
    const result = byProvider.get(platform);
    if (result && result.ok) {
      return { platform, status: 'dispatched', error: null, retryable: false };
    }
    const retryable = result ? result.retryable !== false : true;
    let error = result?.error ?? 'no_result_for_platform';
    // Surface the failure taxonomy in the persisted error_message so an operator
    // inspecting a stuck terminal row sees *why* (e.g. an expired token →
    // reconnect required) instead of an opaque code. Surface-only — the retry
    // policy is still driven entirely by `retryable` above.
    if (result?.kind === 'auth') {
      error = `auth: Meta account disconnected — reconnect required. ${error}`;
    }
    return { platform, status: retryable ? 'pending' : 'failed', error, retryable };
  });
}

/**
 * POST the scheduled-dispatch request and return the per-platform results.
 * Network/timeout and 5xx are retried once; a parsed body's `results` array
 * carries each platform's outcome. Returns { results, transportError } —
 * transportError is set only when no per-platform breakdown is available.
 */
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
      return await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // First attempt
  let res;
  try {
    res = await attempt();
  } catch {
    // Transient network / timeout: retry once
    try {
      res = await attempt();
    } catch (retryError) {
      return { results: [], transportError: `fetch failed after retry: ${String(retryError?.message || retryError)}` };
    }
  }

  // 5xx: retry once. 4xx and 2xx are taken as-is (the route always returns a
  // per-platform `results` body, including for terminal-failure 4xx).
  if (res.status >= 500) {
    try {
      res = await attempt();
    } catch (retryError) {
      return { results: [], transportError: `fetch 5xx retry failed: ${String(retryError?.message || retryError)}` };
    }
  }

  let parsed;
  try {
    parsed = await res.json();
  } catch {
    return { results: [], transportError: `dispatch ${res.status}: unparseable response body` };
  }

  if (Array.isArray(parsed?.results)) {
    return { results: parsed.results, transportError: null };
  }
  return { results: [], transportError: `dispatch ${res.status}: missing per-platform results` };
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

// Exported for the crash-safety regression test, which drives a single tick
// against an in-memory pg fake.
export async function tick(pool) {
  const baseUrl = resolveAppBaseUrl();
  const secret = resolveInternalSecret();

  if (!baseUrl) {
    console.error('[scheduled-posts-worker] APP_BASE_URL not set; skipping tick');
    return { processed: 0, dispatched: 0, failed: 0, skipped: 0 };
  }

  // Fetch due rows: pending rows, plus 'in_flight' rows whose worker pass
  // crashed and have been stuck past the reclaim window. claimRow re-checks
  // both conditions under the row lock.
  const staleCutoff = new Date(Date.now() - IN_FLIGHT_RECLAIM_MS).toISOString();
  const dueResult = await pool.query(DUE_ROWS_SQL, [BATCH_SIZE, staleCutoff]);

  const ids = dueResult.rows.map((r) => r.id);
  const report = { processed: ids.length, dispatched: 0, failed: 0, skipped: 0 };

  for (const rowId of ids) {
    // The claim transaction and the post-publish write each need a pooled
    // connection, but never at the same time: the network publish runs
    // between them with no connection held. Acquire/release per phase so a
    // single row never pins two connections — at worker concurrency that
    // doubled the pool pressure (see guardrail #1, DB_POOL_MAX budgeting).
    let row;
    let platformsToDispatch;
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        row = await claimRow(client, rowId);
        if (!row) {
          report.skipped += 1;
          await client.query('ROLLBACK');
          continue;
        }

        const platforms = Array.isArray(row.target_platforms) ? row.target_platforms : [];

        // Claim the row: seed per-platform child rows and mark the parent
        // 'in_flight' — a NON-terminal state — then COMMIT before any publish.
        // A crash after this commit leaves a reclaimable in_flight row, never
        // a false 'dispatched'. The terminal status is written only after
        // Meta confirms, in the post-publish transaction below.
        await seedPlatformDispatches(client, rowId, platforms);
        await markInFlight(client, rowId);
        // On a stale-in_flight re-claim, a platform that already reached a
        // terminal state — 'dispatched' (went live) or 'failed' (terminal,
        // non-retryable) — must not be dispatched again. Excluding only
        // 'dispatched' would re-send a permanently-failed platform.
        const childResult = await client.query(
          `SELECT platform FROM scheduled_post_dispatches
           WHERE scheduled_post_id = $1 AND status IN ('dispatched', 'failed')`,
          [rowId],
        );
        const alreadyTerminal = new Set(childResult.rows.map((r) => r.platform));
        await client.query('COMMIT');

        platformsToDispatch = platforms.filter((p) => !alreadyTerminal.has(p));
      } catch (claimError) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw claimError;
      } finally {
        // Release the claim connection BEFORE the network publish: the publish
        // holds no DB connection, and the post-publish write acquires a fresh
        // one. A row never pins two connections at once.
        client.release();
      }

      // Fire the dispatch outside any transaction (network call), then write
      // each platform's real outcome to its child row and roll the parent up.
      const { results, transportError } = platformsToDispatch.length > 0
        ? await dispatchWithRetry({ ...row, target_platforms: platformsToDispatch }, baseUrl, secret)
        : { results: [], transportError: null };
      const outcomes = planPlatformOutcomes(platformsToDispatch, results, transportError);

      const fc = await pool.connect();
      try {
        await fc.query('BEGIN');
        for (const outcome of outcomes) {
          await setPlatformDispatchStatus(fc, rowId, outcome.platform, outcome.status, outcome.error);
        }
        const rolled = await syncParentRollup(fc, rowId);
        if (rolled === 'dispatched') {
          await updatePostStatus(fc, row.post_id, 'published');
        } else if (rolled === 'failed') {
          await updatePostStatus(fc, row.post_id, 'failed');
        }
        await fc.query('COMMIT');

        if (rolled === 'dispatched') {
          report.dispatched += 1;
        } else {
          report.failed += 1;
          const errs = outcomes.filter((o) => o.status !== 'dispatched').map((o) => `${o.platform}:${o.error}`);
          console.error(`[scheduled-posts-worker] row=${rowId} rollup=${rolled}`, errs.join('; '));
        }
      } catch (writeError) {
        try { await fc.query('ROLLBACK'); } catch { /* ignore */ }
        throw writeError;
      } finally {
        fc.release();
      }
    } catch (rowError) {
      console.error(`[scheduled-posts-worker] row error id=${rowId}`, rowError);
      report.failed += 1;
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
