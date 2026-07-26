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
import { randomUUID } from 'node:crypto';
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
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 350_000;
const COMPOSE_STOP_GRACE_MS = 360_000;

export function parseShutdownTimeoutMs(raw) {
  if (!raw || !/^\d+$/.test(raw.trim())) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  return parsed > VIDEO_FETCH_TIMEOUT_MS && parsed < COMPOSE_STOP_GRACE_MS
    ? parsed
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

// Must remain above provider I/O and below Compose's six-minute grace period.
const SHUTDOWN_TIMEOUT_MS = parseShutdownTimeoutMs(
  process.env.ARIES_SCHEDULED_POSTS_SHUTDOWN_TIMEOUT_MS,
);
// A row claimed as 'in_flight' but not driven to a terminal state within this
// window is assumed to belong to a crashed worker pass and is re-claimable.
// Comfortably larger than the longest fetch timeout (video) so a slow-but-live
// publish is not stolen mid-flight and re-dispatched into a duplicate.
const IN_FLIGHT_RECLAIM_MS = 15 * 60 * 1000; // 15 minutes (> VIDEO_FETCH_TIMEOUT_MS)

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
         OR (sp.dispatch_status = 'in_flight'
             AND sp.dispatch_started_at IS NULL
             AND sp.dispatch_claimed_at < $2)
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
         OR (dispatch_status = 'in_flight'
             AND dispatch_started_at IS NULL
             AND dispatch_claimed_at < $2)
       )
       AND (campaign_end_date IS NULL OR campaign_end_date >= NOW())
     ORDER BY scheduled_for
     LIMIT $1`;

// Parent-row claim UPDATE, exported for the same regression-test reason. $1 is
// the scheduled_posts id and $2 is a worker-generated immutable ownership
// token. Claim age has its own timestamp so scheduling/metadata writes may
// update updated_at without stealing or extending the live attempt.
export const MARK_IN_FLIGHT_SQL = `UPDATE scheduled_posts
     SET dispatch_status = 'in_flight',
         dispatch_attempt_token = $2,
         dispatch_claimed_at = clock_timestamp(),
         dispatch_started_at = NULL,
         updated_at = clock_timestamp()
     WHERE id = $1
     RETURNING dispatch_attempt_token AS attempt_token`;

// Shutdown may begin while the claim transaction's COMMIT is awaiting the
// database. At that point rollback is no longer available, but provider I/O has
// not started. Release only the exact still-unstarted attempt generation and
// return its retryable children to pending; terminal/manual children stay put.
export const RELEASE_PRE_PROVIDER_CLAIM_SQL = `WITH released_owner AS (
    UPDATE scheduled_posts
       SET dispatch_status = 'pending',
           dispatch_attempt_token = NULL,
           dispatch_claimed_at = NULL,
           updated_at = clock_timestamp()
     WHERE id = $1
       AND dispatch_status = 'in_flight'
       AND dispatch_attempt_token = $2
       AND dispatch_started_at IS NULL
     RETURNING id
  ), released_children AS (
    UPDATE scheduled_post_dispatches dispatch
       SET status = 'pending',
           updated_at = now()
      FROM released_owner owner
     WHERE dispatch.scheduled_post_id = owner.id
       AND dispatch.status = 'in_flight'
     RETURNING dispatch.id
  )
  SELECT count(*)::int AS released FROM released_owner`;

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
             OR (dispatch_status = 'in_flight'
             AND dispatch_started_at IS NULL
             AND dispatch_claimed_at < $2))
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
             OR (sp.dispatch_status = 'in_flight'
             AND sp.dispatch_started_at IS NULL
             AND sp.dispatch_claimed_at < $2))
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

// A started provider request is a point of no safe automatic return: after a
// worker/app crash the provider may have accepted the publish even when no
// response or platform id reached Aries. Stale started attempts are therefore
// terminally quarantined for an operator instead of entering stale reclaim.
export const SWEEP_AMBIGUOUS_DISPATCH_SQL = `WITH ambiguous AS (
    SELECT id, post_id
      FROM scheduled_posts
     WHERE dispatch_status = 'in_flight'
       AND dispatch_started_at IS NOT NULL
       AND dispatch_claimed_at < $2
     ORDER BY dispatch_claimed_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED
  ),
  marked_children AS (
    UPDATE scheduled_post_dispatches dispatch
       SET status = 'manual_reconciliation',
           error_at = now(),
           error_message = 'publish_outcome_unknown: provider request started but durable outcome is missing; manual reconciliation required; no auto-retry',
           updated_at = now()
      FROM ambiguous
     WHERE dispatch.scheduled_post_id = ambiguous.id
       AND dispatch.status IN ('pending', 'in_flight')
     RETURNING dispatch.id
  ),
  marked_posts AS (
    UPDATE posts post
       SET published_status = 'unverified',
           updated_at = now()
      FROM ambiguous
     WHERE post.id = ambiguous.post_id
       AND post.published_status <> 'published'
     RETURNING post.id
  ),
  marked AS (
    UPDATE scheduled_posts owner
       SET dispatch_status = 'manual_reconciliation',
           error_at = now(),
           error_message = 'publish_outcome_unknown: provider request started but durable outcome is missing; manual reconciliation required; no auto-retry',
           updated_at = now()
      FROM ambiguous
     WHERE owner.id = ambiguous.id
       AND owner.dispatch_status = 'in_flight'
       AND owner.dispatch_started_at IS NOT NULL
       AND owner.dispatch_claimed_at < $2
     RETURNING owner.id
  )
  SELECT (SELECT count(*) FROM marked)::int AS swept`;

export async function sweepAmbiguousDispatchRows(pool) {
  const staleCutoff = new Date(Date.now() - IN_FLIGHT_RECLAIM_MS).toISOString();
  const result = await pool.query(SWEEP_AMBIGUOUS_DISPATCH_SQL, [SWEEP_BATCH_SIZE, staleCutoff]);
  const swept = Number(result.rows?.[0]?.swept) || 0;
  if (swept > 0) {
    console.error(
      `[scheduled-posts-worker] quarantined ${swept} stale started attempt(s) for manual reconciliation; automatic republish disabled`,
    );
  }
  return { swept };
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
 * reclaimable row, never a false 'dispatched'. A dedicated token and claimed
 * timestamp keep attempt ownership independent from mutable business metadata.
 */
async function markInFlight(client, rowId) {
  const result = await client.query(MARK_IN_FLIGHT_SQL, [rowId, randomUUID()]);
  const attemptToken = result.rows?.[0]?.attempt_token;
  if (!attemptToken) {
    throw new Error(`scheduled_post_claim_failed:no_attempt_token:${rowId}`);
  }
  return attemptToken;
}

async function releasePreProviderClaim(pool, rowId, attemptToken) {
  const result = await pool.query(RELEASE_PRE_PROVIDER_CLAIM_SQL, [rowId, attemptToken]);
  return Number(result.rows?.[0]?.released ?? 0) === 1;
}

/** Lock canonical post first: route finalization and schedule/delete use the
 * same canonical -> scheduled ordering, so worker reconciliation cannot form a
 * lock cycle with those paths. */
async function lockCanonicalPost(client, postId, tenantId) {
  const result = await client.query(
    `SELECT id
     FROM posts
     WHERE id = $1
       AND tenant_id = $2
     FOR UPDATE`,
    [postId, tenantId],
  );
  return result.rowCount === 1;
}

/** Validate and lock the active parent generation after the canonical post. */
async function lockActiveAttempt(client, rowId, attemptToken) {
  const result = await client.query(
    `SELECT 1
     FROM scheduled_posts
     WHERE id = $1
       AND dispatch_status = 'in_flight'
       AND dispatch_attempt_token = $2
     FOR UPDATE`,
    [rowId, attemptToken],
  );
  return result.rowCount === 1;
}

// --- Per-platform dispatch state ------------------------------------------

/**
 * Roll a set of per-platform statuses up into the single parent
 * scheduled_posts.dispatch_status. A row is only 'dispatched' once every
 * platform succeeded. In-flight and bounded-safe pending work take precedence
 * over manual review so they can finish; an ambiguous child wins only after no
 * retryable work remains. Fully terminal failures otherwise roll up to failed.
 */
export function rollupParentStatus(platformStatuses) {
  const statuses = Array.isArray(platformStatuses) ? platformStatuses : [];
  if (statuses.length === 0) return 'pending';
  if (statuses.every((s) => s === 'dispatched')) return 'dispatched';
  if (statuses.some((s) => s === 'in_flight')) return 'in_flight';
  if (statuses.some((s) => s === 'pending')) return 'pending';
  if (statuses.some((s) => s === 'manual_reconciliation')) return 'manual_reconciliation';
  if (statuses.every((s) => s === 'dispatched' || s === 'failed')) return 'failed';
  return 'pending';
}

/**
 * Seed one scheduled_post_dispatches row per target platform in the
 * non-terminal 'in_flight' state, committed before the publish runs. On a
 * re-claim of a stale row, terminal child evidence is left untouched so a
 * platform that already went live or needs manual review is never re-sent;
 * only non-terminal children are reset to 'in_flight' for the retry.
 */
async function seedPlatformDispatches(client, rowId, platforms) {
  if (platforms.length === 0) return;
  // One multi-row INSERT instead of one round-trip per platform. $1 is the
  // scheduled_post id; $2.. are the platform names. ON CONFLICT keeps the
  // re-claim semantics: terminal dispatched/failed/manual-review evidence is
  // left untouched; only bounded-safe work is reset to 'in_flight'.
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
async function setPlatformDispatchStatus(
  client,
  rowId,
  platform,
  status,
  errorMessage,
  platformPostId,
  attemptToken,
) {
  const truncated = errorMessage ? String(errorMessage).slice(0, 1000) : null;
  // $4 is cast to text everywhere it appears: with the bare parameter in both
  // a CASE result and an IS NOT NULL predicate, Postgres cannot infer its type
  // and rejects the statement with 42P08 "could not determine data type of
  // parameter $4" — which failed EVERY post-publish write (the publish went
  // live but was never recorded, re-opening the stale-reclaim duplicate
  // window). Caught live 2026-07-13 20:05Z; the in-memory test fakes cannot
  // see prepare-time type inference, hence the live-SQL prepare test.
  const result = await client.query(
    `UPDATE scheduled_post_dispatches
     SET status = $3,
         platform_post_id = COALESCE(platform_post_id, $5::text),
         dispatched_at = CASE WHEN $3 = 'dispatched' THEN now() ELSE dispatched_at END,
         error_at = CASE WHEN $3 IN ('failed', 'manual_reconciliation') THEN now() ELSE error_at END,
         error_message = CASE WHEN $3 IN ('failed', 'manual_reconciliation') THEN $4::text
                              WHEN $3 = 'pending' AND $4::text IS NOT NULL THEN $4::text
                              ELSE error_message END,
         updated_at = now()
     WHERE scheduled_post_id = $1
       AND platform = $2
       AND EXISTS (
         SELECT 1
         FROM scheduled_posts owner
         WHERE owner.id = $1
           AND owner.dispatch_status = 'in_flight'
           AND owner.dispatch_attempt_token = $6
       )`,
    [rowId, platform, status, truncated, platformPostId, attemptToken],
  );
  return result.rowCount === 1;
}

/**
 * Reconcile canonical publish truth from durable child evidence while the
 * canonical and scheduled-owner locks are held. This is the worker-side
 * fallback for a route response whose provider POST succeeded but whose
 * canonical/Insights transaction failed. Published and the legacy aggregate
 * provider id are monotonic: later sibling failures can neither demote the
 * canonical post nor replace the first confirmed id.
 */
async function syncCanonicalPublishedState(client, rowId, postId, tenantId, attemptToken) {
  const result = await client.query(
    `UPDATE posts
     SET published_status = 'published',
         platform_post_id = COALESCE(
           posts.platform_post_id,
           (
             SELECT dispatch.platform_post_id
             FROM scheduled_post_dispatches dispatch
             WHERE dispatch.scheduled_post_id = $1
               AND dispatch.status = 'dispatched'
               AND dispatch.platform_post_id IS NOT NULL
             ORDER BY dispatch.dispatched_at ASC NULLS LAST, dispatch.platform ASC
             LIMIT 1
           )
         ),
         published_at = COALESCE(
           posts.published_at,
           (
             SELECT min(dispatch.dispatched_at)
             FROM scheduled_post_dispatches dispatch
             WHERE dispatch.scheduled_post_id = $1
               AND dispatch.status = 'dispatched'
           ),
           now()
         ),
         updated_at = now()
     WHERE posts.id = $2
       AND posts.tenant_id = $3
       AND EXISTS (
         SELECT 1
         FROM scheduled_posts owner
         WHERE owner.id = $1
           AND owner.dispatch_status = 'in_flight'
           AND owner.dispatch_attempt_token = $4
       )
       AND EXISTS (
         SELECT 1
         FROM scheduled_post_dispatches dispatch
         WHERE dispatch.scheduled_post_id = $1
           AND dispatch.status = 'dispatched'
       )
     RETURNING posts.id`,
    [rowId, postId, tenantId, attemptToken],
  );
  return result.rowCount === 1;
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
async function syncParentRollup(client, rowId, attemptToken) {
  const childResult = await client.query(
    `SELECT status, error_message FROM scheduled_post_dispatches WHERE scheduled_post_id = $1`,
    [rowId],
  );
  const statuses = childResult.rows.map((r) => r.status);
  const rolled = rollupParentStatus(statuses);
  const firstError = childResult.rows.find(
    (r) => (r.status === 'failed' || r.status === 'manual_reconciliation') && r.error_message,
  )?.error_message ?? null;
  const result = await client.query(
    `UPDATE scheduled_posts
     SET dispatch_status = $2,
         dispatched_at = CASE WHEN $2 = 'dispatched' THEN now() ELSE dispatched_at END,
         error_at = CASE WHEN $2 IN ('failed', 'manual_reconciliation') THEN now() ELSE error_at END,
         error_message = CASE WHEN $2 IN ('failed', 'manual_reconciliation') THEN $3 ELSE error_message END
     WHERE id = $1
       AND dispatch_status = 'in_flight'
       AND dispatch_attempt_token = $4`,
    [rowId, rolled, firstError, attemptToken],
  );
  return result.rowCount === 1 ? rolled : null;
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
 * `transportError` covers the case where the whole dispatch call failed with no
 * per-platform proof that submission was never reached. Every requested
 * platform is therefore quarantined for manual reconciliation; only an
 * explicit `pre_provider` route result may safely return to pending.
 */
export function planPlatformOutcomes(platforms, results, transportError) {
  const list = Array.isArray(platforms) ? platforms : [];
  const byProvider = new Map(
    (Array.isArray(results) ? results : []).map((r) => [r.provider, r]),
  );
  return list.map((platform) => {
    if (transportError) {
      return {
        platform,
        status: 'manual_reconciliation',
        error: `publish_outcome_unknown (manual reconciliation required; no auto-retry — may already be live): ${transportError}`,
        retryable: false,
        platformPostId: null,
      };
    }
    const result = byProvider.get(platform);
    if (result && result.ok) {
      const platformPostId = typeof result.platformPostId === 'string' && result.platformPostId.trim()
        ? result.platformPostId.trim()
        : null;
      return { platform, status: 'dispatched', error: null, retryable: false, platformPostId };
    }
    if (result?.kind === 'outcome_unknown') {
      return {
        platform,
        status: 'manual_reconciliation',
        error: `publish_outcome_unknown (manual reconciliation required; no auto-retry — may already be live): ${result.error || 'provider outcome unknown'}`,
        retryable: false,
        platformPostId: null,
      };
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
    return { platform, status: retryable ? 'pending' : 'failed', error, retryable, platformPostId: null };
  });
}

/**
 * POST the scheduled-dispatch request and return the per-platform results.
 * Exactly one request is issued per durable attempt token. A parsed body's
 * `results` array carries each platform's known outcome. Returns { results, transportError } —
 * transportError is set only when no per-platform breakdown is available.
 */
async function dispatchOnce(row, attemptToken, baseUrl, secret) {
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
    scheduled_post_id: String(row.id),
    dispatch_attempt_token: attemptToken,
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

  let res;
  try {
    res = await attempt();
  } catch (requestError) {
    return { results: [], transportError: `fetch failed: ${String(requestError?.message || requestError)}` };
  }

  let parsed;
  try {
    parsed = await res.json();
  } catch {
    return { results: [], transportError: `dispatch ${res.status}: unparseable response body` };
  }

  // These responses are emitted before provider I/O. Unlike a response loss or
  // an unclassified 5xx, they prove that no publish could have been accepted and
  // therefore remain safely retryable.
  const knownPreProviderFailure =
    res.status === 401 ||
    res.status === 403 ||
    parsed?.error === 'dispatch_ownership_unavailable';
  if (knownPreProviderFailure) {
    const error = parsed?.error || `dispatch ${res.status}: provider was not reached`;
    return {
      results: platforms.map((provider) => ({
        provider,
        ok: false,
        error,
        retryable: true,
        kind: 'pre_provider',
      })),
      transportError: null,
    };
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
export async function tick(pool, { shouldStop = () => false } = {}) {
  const baseUrl = resolveAppBaseUrl();
  const secret = resolveInternalSecret();

  if (!baseUrl) {
    console.error('[scheduled-posts-worker] APP_BASE_URL not set; skipping tick');
    return { processed: 0, dispatched: 0, failed: 0, skipped: 0, expired: 0 };
  }

  // Quarantine stale attempts that crossed the provider-submission fence before
  // any other stale-row handling; these must never enter automatic reclaim.
  let ambiguousSweep = { swept: 0 };
  try {
    ambiguousSweep = await sweepAmbiguousDispatchRows(pool);
  } catch (sweepError) {
    console.error('[scheduled-posts-worker] ambiguous-dispatch sweep error (isolated; dispatch continues)', sweepError);
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
  const report = {
    processed: ids.length,
    dispatched: 0,
    failed: 0,
    skipped: 0,
    expired: sweep.swept,
    manualReconciliation: ambiguousSweep.swept,
  };

  for (let rowIndex = 0; rowIndex < ids.length; rowIndex += 1) {
    if (shouldStop()) {
      report.skipped += ids.length - rowIndex;
      break;
    }
    const rowId = ids[rowIndex];
    // The claim transaction and the post-publish write each need a pooled
    // connection, but never at the same time: the network publish runs
    // between them with no connection held. Acquire/release per phase so a
    // single row never pins two connections — at worker concurrency that
    // doubled the pool pressure (see guardrail #1, DB_POOL_MAX budgeting).
    let row;
    let platformsToDispatch;
    let attemptToken;
    try {
      const client = await pool.connect();
      try {
        // A signal can arrive while pool.connect() is pending. Re-check before
        // beginning the claim so a prefetched later row never crosses into
        // provider work after shutdown starts.
        if (shouldStop()) {
          report.skipped += ids.length - rowIndex;
          break;
        }
        await client.query('BEGIN');

        if (shouldStop()) {
          report.skipped += ids.length - rowIndex;
          await client.query('ROLLBACK');
          break;
        }

        row = await claimRow(client, rowId);
        if (!row) {
          report.skipped += 1;
          await client.query('ROLLBACK');
          continue;
        }
        if (shouldStop()) {
          report.skipped += ids.length - rowIndex;
          await client.query('ROLLBACK');
          break;
        }

        const platforms = Array.isArray(row.target_platforms) ? row.target_platforms : [];

        // Claim the row: seed per-platform child rows and mark the parent
        // 'in_flight' — a NON-terminal state — then COMMIT before any publish.
        // A crash after this commit leaves a reclaimable in_flight row, never
        // a false 'dispatched'. The terminal status is written only after
        // Meta confirms, in the post-publish transaction below.
        await seedPlatformDispatches(client, rowId, platforms);
        if (shouldStop()) {
          report.skipped += ids.length - rowIndex;
          await client.query('ROLLBACK');
          break;
        }
        attemptToken = await markInFlight(client, rowId);
        if (shouldStop()) {
          report.skipped += ids.length - rowIndex;
          await client.query('ROLLBACK');
          break;
        }
        // On a stale-in_flight re-claim, a platform that already reached a
        // terminal state — 'dispatched' (went live), 'failed' (terminal,
        // non-retryable), or 'manual_reconciliation' (outcome unknown) — must
        // not be dispatched again. A pending sibling keeps the parent
        // claimable, but the ambiguous child stays quarantined on every retry.
        const childResult = await client.query(
          `SELECT platform FROM scheduled_post_dispatches
           WHERE scheduled_post_id = $1
             AND status IN ('dispatched', 'failed', 'manual_reconciliation')`,
          [rowId],
        );
        const alreadyTerminal = new Set(childResult.rows.map((r) => r.platform));
        if (shouldStop()) {
          report.skipped += ids.length - rowIndex;
          await client.query('ROLLBACK');
          break;
        }
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

      // A signal can arrive while COMMIT itself awaits. The just-created claim
      // is durable then, so roll it back with an ownership-fenced statement
      // before leaving the loop. There is no await between this final stop check
      // and dispatchOnce's fetch, closing the entire claim-to-provider gap.
      if (shouldStop()) {
        const released = await releasePreProviderClaim(pool, rowId, attemptToken);
        if (!released) {
          throw new Error(`scheduled_post_shutdown_release_failed:${rowId}`);
        }
        report.skipped += ids.length - rowIndex;
        break;
      }

      // Fire the dispatch outside any transaction (network call), then write
      // each platform's real outcome to its child row and roll the parent up.
      const { results, transportError } = platformsToDispatch.length > 0
        ? await dispatchOnce({ ...row, target_platforms: platformsToDispatch }, attemptToken, baseUrl, secret)
        : { results: [], transportError: null };
      const outcomes = planPlatformOutcomes(platformsToDispatch, results, transportError);

      const fc = await pool.connect();
      try {
        await fc.query('BEGIN');
        const canonicalLocked = await lockCanonicalPost(fc, row.post_id, row.tenant_id);
        let ownsAttempt = canonicalLocked
          && await lockActiveAttempt(fc, rowId, attemptToken);
        if (!ownsAttempt) {
          await fc.query('COMMIT');
          report.skipped += 1;
          continue;
        }
        for (const outcome of outcomes) {
          ownsAttempt = await setPlatformDispatchStatus(
            fc,
            rowId,
            outcome.platform,
            outcome.status,
            outcome.error,
            outcome.platformPostId,
            attemptToken,
          );
          if (!ownsAttempt) break;
        }
        if (ownsAttempt) {
          await syncCanonicalPublishedState(
            fc,
            rowId,
            row.post_id,
            row.tenant_id,
            attemptToken,
          );
        }
        const rolled = ownsAttempt
          ? await syncParentRollup(fc, rowId, attemptToken)
          : null;
        if (rolled === null) {
          // A newer reclaim owns this row. Commit the no-op conditional writes
          // and leave the newer attempt's children and parent untouched.
          await fc.query('COMMIT');
          report.skipped += 1;
          continue;
        }
        if (rolled !== 'dispatched'
          && rolled !== 'failed'
          && rolled !== 'manual_reconciliation') {
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

export function createScheduledPostsWorkerRuntime(pool) {
  let activeTick = null;
  let stopping = false;

  async function runTick() {
    if (stopping || activeTick) {
      console.warn('[scheduled-posts-worker] previous tick still running or shutdown started; skipping');
      return { processed: 0, dispatched: 0, failed: 0, skipped: 1, expired: 0, manualReconciliation: 0 };
    }
    const current = tick(pool, { shouldStop: () => stopping });
    activeTick = current;
    try {
      const report = await current;
      if (report.processed > 0 || report.failed > 0 || report.expired > 0 || report.manualReconciliation > 0) {
        console.log(`[scheduled-posts-worker] summary ${JSON.stringify(report)}`);
      }
      return report;
    } catch (error) {
      console.error('[scheduled-posts-worker] tick error', error);
      return { processed: 0, dispatched: 0, failed: 1, skipped: 0, expired: 0, manualReconciliation: 0 };
    } finally {
      if (activeTick === current) activeTick = null;
    }
  }

  async function shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS) {
    stopping = true;
    if (activeTick) {
      let timeout;
      const completed = await Promise.race([
        activeTick.then(() => true, () => true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!completed) {
        console.error(
          `[scheduled-posts-worker] shutdown drain exceeded ${timeoutMs}ms; exiting without closing the active pool so the started-at fence can quarantine any unknown outcome`,
        );
        return false;
      }
    }
    if (typeof pool.end === 'function') await pool.end();
    return true;
  }

  return { runTick, shutdown };
}

export function installScheduledPostsWorkerSignalHandlers(
  runtime,
  {
    processRef = process,
    getIntervalHandle = () => intervalHandle,
    exitProcess = (code) => process.exit(code),
  } = {},
) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    processRef.once(signal, async () => {
      const handle = getIntervalHandle();
      if (handle) clearInterval(handle);
      const drained = await runtime.shutdown().catch((error) => {
        console.error('[scheduled-posts-worker] shutdown error', error);
        return false;
      });
      exitProcess(drained ? 0 : 1);
    });
  }
}

async function main() {
  const pool = buildPool();
  const runtime = createScheduledPostsWorkerRuntime(pool);

  // Install before the initial tick: deploy may signal the container while its
  // first due batch is already in provider I/O.
  installScheduledPostsWorkerSignalHandlers(runtime);

  console.log(`[scheduled-posts-worker] starting; interval=${INTERVAL_MS}ms batch=${BATCH_SIZE}`);

  await runtime.runTick();

  if (process.env.ARIES_SCHEDULED_POSTS_RUN_ONCE?.trim() === '1') {
    await runtime.shutdown();
    process.exit(0);
  }

  intervalHandle = setInterval(() => void runtime.runTick(), INTERVAL_MS);

}

// Only auto-start when run directly as a script; importing this module (e.g.
// from a regression test for CLAIM_ROW_SQL) must not spin up the worker loop.
const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  void main();
}
