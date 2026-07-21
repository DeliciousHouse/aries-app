/**
 * Scheduled-posts worker — drains the scheduled_posts table and fires
 * publishToMetaGraph for each row whose scheduled_for <= NOW() and
 * dispatch_status = 'pending'. Runs as the aries-scheduled-posts-worker compose sidecar (self-scheduling; the legacy host cron that double-dispatched alongside it was removed 2026-07-13).
 *
 * Each tick also runs the dead-campaign sweep (SWEEP_DEAD_CAMPAIGN_SQL):
 * rows whose campaign_end_date has passed are permanently excluded by the
 * claim filter, so without the sweep they rot as invisible forever-'pending'
 * while their posts still read 'approved' (the 2026-07-21 stuck-queue
 * incident). The sweep marks them terminally failed and expires the posts.
 */
import 'dotenv/config';

import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const INTERVAL_MS = 60 * 1000; // 1 minute
const BATCH_SIZE = 50;
// Dead-campaign sweep batch. The population is bounded by scheduling volume
// (a handful of rows per tenant-week), so one batch per tick converges fast;
// a full batch is logged loudly so a larger backlog is never silently capped.
const SWEEP_BATCH_SIZE = 200;
const FETCH_TIMEOUT_MS = 30_000;
// VIDEO publish is a long async two-step (create container -> poll up to ~300s
// -> publish), run synchronously by the dispatch route. The worker MUST wait
// past that poll ceiling: at 30s the fetch aborts while the publish completes
// server-side, the row reverts to 'pending', and the next tick re-dispatches ->
// a DUPLICATE Reel each cycle (the 8x-IG-reel incident, 2026-06-26). Image rows
// keep the short timeout so one slow video never stalls the image batch.
const VIDEO_FETCH_TIMEOUT_MS = 330_000; // > composio IG video max_wait_seconds (300s)
// A row claimed as 'in_flight' but not driven to a terminal state within this
// window is assumed to belong to a crashed worker pass and is re-claimable.
// Comfortably larger than the longest fetch timeout (video) so a slow-but-live
// publish is not stolen mid-flight and re-dispatched into a duplicate.
const IN_FLIGHT_RECLAIM_MS = 15 * 60 * 1000; // 15 minutes (> VIDEO_FETCH_TIMEOUT_MS)

let running = false;
let intervalHandle = null;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

// Mirrors lib/db-pool-config.ts parsePoolMax (this worker runs under plain
// node, so it cannot import the TS helper): honor an explicit integer
// DB_POOL_MAX in [1, 200]; anything else falls back to the worker default 3.
export function parseWorkerPoolMax(raw) {
  if (!raw) return 3;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) < 1) {
    console.warn(`[db-pool] invalid DB_POOL_MAX ${JSON.stringify(raw)}; using default 3`);
    return 3;
  }
  return Math.min(200, Number.parseInt(trimmed, 10));
}

function buildPool() {
  return new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: parseWorkerPoolMax(process.env.DB_POOL_MAX),
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
// Retry backoff: a pending row whose next_attempt_at is still in the future is
// not claimable (set after a retryable failure — see classifyRetryBackoffMinutes).
// The stale-in_flight reclaim arm deliberately ignores next_attempt_at: a
// crashed worker pass is not a backoff.
export const CLAIM_ROW_SQL = `SELECT sp.id, sp.post_id, sp.tenant_id, sp.target_platforms,
            sp.surface, sp.media_type,
            sp.width_px, sp.height_px, sp.duration_seconds,
            p.caption, p.platform_post_id
     FROM scheduled_posts sp
     LEFT JOIN posts p ON p.id = sp.post_id
     WHERE sp.id = $1
       AND (
         (sp.dispatch_status = 'pending'
          AND (sp.next_attempt_at IS NULL OR sp.next_attempt_at <= NOW()))
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
         (dispatch_status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
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

// Dead-campaign sweep: terminally mark rows the campaign_end_date filter above
// has made permanently unclaimable. Without this, a row that misses its window
// (retry backoff, guard deferral, worker outage) stays dispatch_status='pending'
// FOREVER while its posts row still reads 'approved' — a full week of content
// silently undelivered with nothing in any UI saying so (12 such rows found in
// prod 2026-07-21, scheduled 7/07-7/18 with campaign_end 7/13 and 7/20).
//
// Semantics (deliberate):
//   - Delivery still STOPS at campaign_end_date — this sweep never publishes
//     late. For a one_off event campaign, posting after the event ends is
//     wrong (promoting an ended sale); weekly jobs share the same column, so a
//     grace-delivery window cannot be added here without splitting the two
//     populations. Considered and rejected for now; the fix is visibility.
//   - Parent -> dispatch_status='failed' (the EXISTING terminal vocabulary —
//     labels.ts, calendar.ts, and the child-table CHECK constraint all already
//     handle 'failed'; a new enum value would need every consumer audited for
//     ===/!== literal checks, the widening-union trap this repo shipped 3x).
//     The canonical 'campaign_window_passed:' error_message prefix is what
//     distinguishes it, with the per-row end date interpolated for diagnosis.
//   - Posts mirror -> published_status='expired' (+ legacy status mirror +
//     expired_at), the draft-expiry-sweep vocabulary for "aged out, never went
//     live", so the row leaves the approval/backlog trays honestly. Guarded by
//     published_at IS NULL AND platform_post_id IS NULL AND a pre-publish
//     published_status, so a post that is live anywhere is NEVER expired.
//   - Non-terminal children -> 'failed' too, but COALESCE keeps an existing
//     retryable error_message (e.g. the FB-368 rate-limit text that caused the
//     miss) — that is the diagnosis, the parent carries the classification.
//   - pending rows sweep immediately once the deadline passes (they are already
//     unclaimable); in_flight rows only once STALE past the reclaim window
//     ($2, same cutoff as CLAIM_ROW_SQL), so a live publish that crossed the
//     deadline mid-flight still writes its own real outcome.
//   - Every mutating arm re-checks the full predicate (draft-expiry-sweep
//     pattern) and the dead CTE takes FOR UPDATE SKIP LOCKED, so a row being
//     claimed/finished concurrently is skipped, never clobbered. Idempotent:
//     a swept row no longer matches.
// $1 = batch limit, $2 = stale-in_flight cutoff timestamp.
export const SWEEP_DEAD_CAMPAIGN_SQL = `WITH dead AS (
     SELECT id, post_id FROM scheduled_posts
      WHERE campaign_end_date IS NOT NULL AND campaign_end_date < NOW()
        AND (dispatch_status = 'pending'
             OR (dispatch_status = 'in_flight' AND updated_at < $2))
      ORDER BY scheduled_for
      LIMIT $1
      FOR UPDATE SKIP LOCKED
   ),
   marked AS (
     UPDATE scheduled_posts sp
        SET dispatch_status = 'failed',
            error_at = now(),
            -- The message must be TRUE for partial-success rows: a cross-post
            -- row with one platform already live rolls up 'pending' and is
            -- swept too — claiming "never published" there invites a manual
            -- re-publish of the live platform (a duplicate-post hazard).
            error_message = 'campaign_window_passed: campaign_end_date '
              || to_char(sp.campaign_end_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              || CASE WHEN EXISTS (SELECT 1 FROM scheduled_post_dispatches spd0
                                    WHERE spd0.scheduled_post_id = sp.id
                                      AND spd0.status = 'dispatched')
                 THEN ' elapsed before full dispatch; at least one platform already published (see per-platform rows) — the remaining platform(s) were never sent (swept terminal by scheduled-posts-worker)'
                 ELSE ' elapsed before dispatch; post was never published (swept terminal by scheduled-posts-worker)'
                 END,
            updated_at = now()
       FROM dead d
      WHERE sp.id = d.id
        AND sp.campaign_end_date IS NOT NULL AND sp.campaign_end_date < NOW()
        AND (sp.dispatch_status = 'pending'
             OR (sp.dispatch_status = 'in_flight' AND sp.updated_at < $2))
      RETURNING sp.id, sp.post_id
   ),
   swept_children AS (
     UPDATE scheduled_post_dispatches spd
        SET status = 'failed',
            error_at = now(),
            error_message = COALESCE(spd.error_message,
              'campaign_window_passed: never dispatched before campaign end'),
            updated_at = now()
       FROM marked m
      WHERE spd.scheduled_post_id = m.id
        AND spd.status IN ('pending','in_flight')
      RETURNING spd.id
   ),
   expired_posts AS (
     UPDATE posts p
        SET published_status = 'expired',
            status = 'expired',
            expired_at = now(),
            updated_at = now()
       FROM marked m
      WHERE p.id = m.post_id
        AND p.published_at IS NULL
        AND p.platform_post_id IS NULL
        AND p.published_status IN ('draft','in_review','approved')
      RETURNING p.id
   )
   SELECT (SELECT count(*) FROM marked)::int AS swept,
          (SELECT count(*) FROM expired_posts)::int AS posts_expired`;

/**
 * One dead-campaign sweep pass (single batched statement). Returns counts.
 * Exported for the regression test; called once per tick, failure-isolated so
 * a sweep error can never stall dispatch.
 */
export async function sweepDeadCampaignRows(pool) {
  const staleCutoff = new Date(Date.now() - IN_FLIGHT_RECLAIM_MS).toISOString();
  const result = await pool.query(SWEEP_DEAD_CAMPAIGN_SQL, [SWEEP_BATCH_SIZE, staleCutoff]);
  const row = result.rows?.[0] ?? {};
  const swept = Number(row.swept) || 0;
  const postsExpired = Number(row.posts_expired) || 0;
  if (swept > 0) {
    console.warn(
      `[scheduled-posts-worker] dead-campaign sweep: ${swept} row(s) past campaign_end_date marked failed (${postsExpired} post(s) expired)${swept >= SWEEP_BATCH_SIZE ? ' — full batch, more may remain; continuing next tick' : ''}`,
    );
  }
  return { swept, postsExpired };
}

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

/** Set a single platform's child-row status (with optional error detail).
 * The error is persisted for 'pending' (retryable) outcomes too — a row that
 * silently retried every tick for days with no recorded reason (FB rate limit
 * 368, 2026-07-13 incident) was undiagnosable from the DB alone. error_at
 * still marks terminal failures only. */
async function setPlatformDispatchStatus(client, rowId, platform, status, errorMessage) {
  const truncated = errorMessage ? String(errorMessage).slice(0, 1000) : null;
  // $4 is cast to text everywhere it appears: with the bare parameter in both
  // a CASE result and an IS NOT NULL predicate, Postgres cannot infer its type
  // and rejects the statement with 42P08 "could not determine data type of
  // parameter $4" — which failed EVERY post-publish write (the publish went
  // live but was never recorded, re-opening the stale-reclaim duplicate
  // window). Caught live 2026-07-13 20:05Z; the in-memory test fakes cannot
  // see prepare-time type inference, hence the live-SQL prepare test.
  await client.query(
    `UPDATE scheduled_post_dispatches
     SET status = $3,
         dispatched_at = CASE WHEN $3 = 'dispatched' THEN now() ELSE dispatched_at END,
         error_at = CASE WHEN $3 = 'failed' THEN now() ELSE error_at END,
         error_message = CASE WHEN $3 = 'failed' THEN $4::text
                              WHEN $3 = 'pending' AND $4::text IS NOT NULL THEN $4::text
                              ELSE error_message END,
         updated_at = now()
     WHERE scheduled_post_id = $1 AND platform = $2`,
    [rowId, platform, status, truncated],
  );
}

// --- Retry backoff ----------------------------------------------------------

// Platform rate-limit signatures. FB error 368 ("We limit how often you can
// post ... You can try again later"), IG/Graph request-limit codes 4/17/613.
// Matched against the persisted error text — coarse by design; a false match
// only lengthens a retry delay, never drops a post.
const RATE_LIMIT_ERROR_RE = /\(code (368|4|17|613)\)|rate.?limit|request limit reached|try again later/i;

function parseBackoffMinutesEnv(raw, fallback) {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return parsed >= 1 ? parsed : fallback;
}

/**
 * Decide the next-attempt backoff (minutes) for a row whose rollup stayed
 * non-terminal. Returns null when nothing is retrying (no backoff write).
 * Rate-limit-classified failures wait much longer — retrying a platform
 * rate limit at tick cadence sustains the limit indefinitely.
 */
export function classifyRetryBackoffMinutes(outcomes, env = process.env) {
  const retrying = (Array.isArray(outcomes) ? outcomes : []).filter((o) => o.status === 'pending');
  if (retrying.length === 0) return null;
  const general = parseBackoffMinutesEnv(env.ARIES_DISPATCH_RETRY_BACKOFF_MINUTES, 10);
  const rateLimit = parseBackoffMinutesEnv(env.ARIES_DISPATCH_RATE_LIMIT_BACKOFF_MINUTES, 180);
  const hitRateLimit = retrying.some((o) => o.error && RATE_LIMIT_ERROR_RE.test(String(o.error)));
  return hitRateLimit ? rateLimit : general;
}

/** Persist the backoff marker so the due-rows scan skips the row until then. */
async function setNextAttemptAt(client, rowId, backoffMinutes) {
  await client.query(
    `UPDATE scheduled_posts SET next_attempt_at = now() + make_interval(mins => $2::int) WHERE id = $1`,
    [rowId, backoffMinutes],
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
 * per-platform breakdown available) — every requested platform stays retryable,
 * EXCEPT video: a transport timeout on a long async video publish means the
 * outcome is UNKNOWN (the route may have published server-side), so retrying
 * would re-create the IG container and duplicate the Reel. Video transport
 * errors are therefore terminal-non-retryable, surfaced for manual check.
 */
export function planPlatformOutcomes(platforms, results, transportError, mediaType) {
  const list = Array.isArray(platforms) ? platforms : [];
  const isVideo = mediaType === 'video';
  const byProvider = new Map(
    (Array.isArray(results) ? results : []).map((r) => [r.provider, r]),
  );
  return list.map((platform) => {
    if (transportError) {
      if (isVideo) {
        return {
          platform,
          status: 'failed',
          error: `video_publish_outcome_unknown (no auto-retry — may already be live): ${transportError}`,
          retryable: false,
        };
      }
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

  // Video publishes synchronously poll IG up to ~300s in the route, so the
  // worker must wait past that ceiling or it aborts mid-publish and duplicates.
  const isVideoRow = (typeof row.media_type === 'string' ? row.media_type : 'image') === 'video';
  const fetchTimeoutMs = isVideoRow ? VIDEO_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS;

  const url = `${baseUrl}/api/internal/publishing/scheduled-dispatch`;

  const body = JSON.stringify({
    tenant_id: tenantId,
    post_id: String(row.post_id),
    platforms,
    content,
    // Forward the publish shape so the dispatch route routes feed/story/reel and
    // image/video correctly. Default to feed/image for legacy rows.
    surface: typeof row.surface === 'string' ? row.surface : 'feed',
    media_type: typeof row.media_type === 'string' ? row.media_type : 'image',
    width_px: row.width_px ?? null,
    height_px: row.height_px ?? null,
    duration_seconds: row.duration_seconds ?? null,
  });

  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${secret}`,
  };

  async function attempt() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
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
    return { processed: 0, dispatched: 0, failed: 0, skipped: 0, expired: 0 };
  }

  // Terminally mark rows whose campaign window has passed BEFORE scanning for
  // due work — they are permanently unclaimable, and leaving them 'pending'
  // hides a delivery failure from every surface. Isolated: a sweep error must
  // never stall dispatch of live rows.
  let sweep = { swept: 0, postsExpired: 0 };
  try {
    sweep = await sweepDeadCampaignRows(pool);
  } catch (sweepError) {
    console.error('[scheduled-posts-worker] dead-campaign sweep error (isolated; dispatch continues)', sweepError);
  }

  // Fetch due rows: pending rows, plus 'in_flight' rows whose worker pass
  // crashed and have been stuck past the reclaim window. claimRow re-checks
  // both conditions under the row lock.
  const staleCutoff = new Date(Date.now() - IN_FLIGHT_RECLAIM_MS).toISOString();
  const dueResult = await pool.query(DUE_ROWS_SQL, [BATCH_SIZE, staleCutoff]);

  const ids = dueResult.rows.map((r) => r.id);
  const report = { processed: ids.length, dispatched: 0, failed: 0, skipped: 0, expired: sweep.swept };

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
      const outcomes = planPlatformOutcomes(platformsToDispatch, results, transportError, row.media_type);

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
        } else {
          // Non-terminal: at least one platform is retrying. Back off instead
          // of re-claiming at tick cadence — 60s retries against a platform
          // rate limit (FB 368) keep the limit tripped forever.
          const backoffMinutes = classifyRetryBackoffMinutes(outcomes);
          if (backoffMinutes !== null) {
            await setNextAttemptAt(fc, rowId, backoffMinutes);
          }
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
    if (report.processed > 0 || report.failed > 0 || report.expired > 0) {
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
