/**
 * Durable storage for customer incident reports (SC-70 port). This is the
 * backstop for the plan's "persist FIRST" invariant: the submit path commits
 * the row before any Jira I/O, so a Jira exception can never lose a report.
 *
 * Every function takes the pool explicitly (the app route passes lib/db's
 * shared pool; the retry-sweep sidecar passes its own, mirroring
 * backend/marketing/draft-expiry-sweep.ts).
 */

import type { Pool, PoolClient } from 'pg';

import type { FeedbackImpact, FeedbackReportCategory } from '@/lib/feedback/report-options';
import type { ReportSubmitterAttribution } from './report-submitter';

export type FeedbackReportStatus = 'pending' | 'synced' | 'pending_retry' | 'failed';
export type JiraCreateState = 'not_started' | 'in_flight' | 'uncertain' | 'completed';
export type FeedbackAttachmentState =
  | 'none'
  | 'in_flight'
  | 'uncertain'
  | 'completed'
  | 'retained_private';

export interface FeedbackReportRecord {
  id: string;
  requestFingerprint: string;
  submitterType: ReportSubmitterAttribution;
  tenantId: string;
  submitterId: string;
  submitterEmail: string | null;
  submitterName: string | null;
  customerSlug: string;
  category: FeedbackReportCategory;
  impact: FeedbackImpact;
  title: string;
  description: string;
  screenshot: { bytes: Buffer; mime: string } | null;
}

export interface FeedbackReportRow {
  id: string;
  request_fingerprint: string;
  submitter_type: ReportSubmitterAttribution;
  tenant_id: string;
  submitter_id: string;
  submitter_email: string | null;
  submitter_name: string | null;
  customer_slug: string;
  category: string;
  impact: string;
  title: string;
  description: string;
  screenshot_bytes: Buffer | null;
  screenshot_mime: string | null;
  jira_ticket_key: string | null;
  jira_create_state: JiraCreateState;
  jira_create_token: string | null;
  attachment_state: FeedbackAttachmentState;
  status: FeedbackReportStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const LAST_ERROR_MAX = 4000;

let ensured = false;

/**
 * Create the table on demand (mirrors lib/feedback/feedback-store.ts). The
 * migration in migrations/20260703000000_feedback_reports.sql is the canonical
 * schema; this keeps the feature working on databases where the migration has
 * not run yet. Idempotent.
 */
export async function ensureFeedbackReportsTable(pool: Pool): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_reports (
      id TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL DEFAULT '',
      submitter_type TEXT NOT NULL DEFAULT 'authenticated'
        CHECK (submitter_type IN ('authenticated','anonymous')),
      tenant_id TEXT NOT NULL,
      submitter_id TEXT NOT NULL,
      submitter_email TEXT,
      submitter_name TEXT,
      customer_slug TEXT NOT NULL DEFAULT 'unknown',
      category TEXT NOT NULL CHECK (category IN ('bug','question','other')),
      impact TEXT NOT NULL CHECK (impact IN (
        'p0_system_blocked','p1_account_blocked','p2_feature_degraded',
        'p3_minor_glitch','p4_question'
      )),
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      screenshot_bytes BYTEA,
      screenshot_mime VARCHAR(64),
      jira_ticket_key VARCHAR(50),
      jira_create_state TEXT NOT NULL DEFAULT 'not_started'
        CHECK (jira_create_state IN ('not_started','in_flight','uncertain','completed')),
      jira_create_token TEXT,
      attachment_state TEXT NOT NULL DEFAULT 'none'
        CHECK (attachment_state IN ('none','in_flight','uncertain','completed','retained_private')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','synced','pending_retry','failed')),
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // CREATE TABLE IF NOT EXISTS is a no-op for existing production tables.
  await pool.query(`
    ALTER TABLE feedback_reports
      ADD COLUMN IF NOT EXISTS submitter_type TEXT NOT NULL DEFAULT 'authenticated'
        CHECK (submitter_type IN ('authenticated','anonymous'))
  `);
  await pool.query(`
    ALTER TABLE feedback_reports
      ADD COLUMN IF NOT EXISTS request_fingerprint TEXT NOT NULL DEFAULT ''
  `);
  await pool.query(`
    DO $feedback_delivery_state$
    DECLARE
      jira_create_state_was_missing BOOLEAN;
      attachment_state_was_missing BOOLEAN;
    BEGIN
      LOCK TABLE feedback_reports IN ACCESS EXCLUSIVE MODE;

      SELECT NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'feedback_reports'
           AND column_name = 'jira_create_state'
      ) INTO jira_create_state_was_missing;
      SELECT NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'feedback_reports'
           AND column_name = 'attachment_state'
      ) INTO attachment_state_was_missing;

      ALTER TABLE feedback_reports
        ADD COLUMN IF NOT EXISTS jira_create_state TEXT NOT NULL DEFAULT 'not_started'
          CHECK (jira_create_state IN ('not_started','in_flight','uncertain','completed')),
        ADD COLUMN IF NOT EXISTS jira_create_token TEXT,
        ADD COLUMN IF NOT EXISTS attachment_state TEXT NOT NULL DEFAULT 'none'
          CHECK (attachment_state IN ('none','in_flight','uncertain','completed','retained_private'));

      IF jira_create_state_was_missing THEN
        UPDATE feedback_reports
           SET jira_create_state = 'completed'
         WHERE jira_ticket_key IS NOT NULL;
        UPDATE feedback_reports
           SET jira_create_state = 'uncertain',
               jira_create_token = COALESCE(jira_create_token, 'aries-sub-' || id)
         WHERE jira_ticket_key IS NULL;
      END IF;

      IF attachment_state_was_missing THEN
        UPDATE feedback_reports
           SET attachment_state = 'uncertain'
         WHERE screenshot_bytes IS NOT NULL;
      END IF;
    END
    $feedback_delivery_state$
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_feedback_reports_status_updated
       ON feedback_reports (status, updated_at)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_feedback_reports_tenant_submitter_created
       ON feedback_reports (tenant_id, submitter_id, created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_feedback_reports_ticket_key
       ON feedback_reports (jira_ticket_key)`,
  );
  ensured = true;
}

/** Reset memoization — for tests that swap the pool/schema. */
export function resetFeedbackReportsEnsuredForTests(): void {
  ensured = false;
}

export type InsertReportOutcome =
  | { outcome: 'ok' }
  | { outcome: 'rate_limited' }
  | { outcome: 'duplicate' }
  | { outcome: 'replay'; report: FeedbackReportRow }
  | { outcome: 'idempotency_conflict' };

async function countRecentForSubmitter(
  client: PoolClient,
  tenantId: string,
  submitterId: string,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM feedback_reports
      WHERE tenant_id = $1 AND submitter_id = $2
        AND created_at > now() - interval '1 hour'`,
    [tenantId, submitterId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Serialize submitter bucket → rate limit → dedup → INSERT, all in ONE
 * transaction.
 *
 * INVARIANT (SC-70): the transaction-scoped advisory lock makes every request
 * for one tenant+submitter observe the preceding committed insert before it
 * counts or checks content. Parallel bursts therefore cannot overrun the cap
 * or persist identical reports. Different submitters remain independent.
 */
export async function insertReportWithLimits(
  pool: Pool,
  record: FeedbackReportRecord,
  limits: {
    userRateLimitPerHour: number;
    sharedRateLimitPerHour?: number;
    dedupWindowSeconds: number;
  },
): Promise<InsertReportOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The browser key is global, so serialize it before checking ownership.
    // This block must stay ahead of the shared/per-user limits and duplicate
    // check: a valid replay still succeeds after the first request consumes the
    // last quota slot. Another identity cannot race the original INSERT into a
    // unique-constraint error or observe an uncommitted row.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('feedback-report-idempotency'), hashtext($1))`,
      [record.id],
    );
    const existing = await client.query<FeedbackReportRow>(
      `SELECT * FROM feedback_reports WHERE id = $1`,
      [record.id],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const sameOwnerAndPayload =
        row.submitter_type === record.submitterType &&
        row.tenant_id === record.tenantId &&
        row.submitter_id === record.submitterId &&
        row.request_fingerprint === record.requestFingerprint;
      await client.query('COMMIT');
      return sameOwnerAndPayload
        ? { outcome: 'replay', report: row }
        : { outcome: 'idempotency_conflict' };
    }

    // Shared durable tenant/endpoint ceiling. This lock intentionally precedes
    // the narrower submitter lock on every path so different identities cannot
    // race the aggregate count or deadlock through inconsistent lock ordering.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('feedback-report-shared'), hashtext($1))`,
      [record.tenantId],
    );
    const shared = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM feedback_reports
        WHERE tenant_id = $1
          AND created_at > now() - interval '1 hour'`,
      [record.tenantId],
    );
    if (
      Number(shared.rows[0]?.count ?? 0) >=
      (limits.sharedRateLimitPerHour ?? Number.MAX_SAFE_INTEGER)
    ) {
      await client.query('ROLLBACK');
      return { outcome: 'rate_limited' };
    }

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [record.tenantId, record.submitterId],
    );

    const before = await countRecentForSubmitter(client, record.tenantId, record.submitterId);
    if (before >= limits.userRateLimitPerHour) {
      await client.query('ROLLBACK');
      return { outcome: 'rate_limited' };
    }

    const dup = await client.query(
      `SELECT 1
         FROM feedback_reports
        WHERE tenant_id = $1 AND submitter_id = $2
          AND title = $3 AND description = $4
          AND created_at > now() - ($5 * interval '1 second')
        LIMIT 1`,
      [
        record.tenantId,
        record.submitterId,
        record.title,
        record.description,
        limits.dedupWindowSeconds,
      ],
    );
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return { outcome: 'duplicate' };
    }

    await client.query(
      `INSERT INTO feedback_reports (
         id, request_fingerprint, submitter_type, tenant_id, submitter_id,
         submitter_email, submitter_name,
         customer_slug, category, impact, title, description,
         screenshot_bytes, screenshot_mime, attachment_state, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending')`,
      [
        record.id,
        record.requestFingerprint,
        record.submitterType,
        record.tenantId,
        record.submitterId,
        record.submitterEmail,
        record.submitterName,
        record.customerSlug,
        record.category,
        record.impact,
        record.title,
        record.description,
        record.screenshot?.bytes ?? null,
        record.screenshot?.mime ?? null,
        record.screenshot ? 'retained_private' : 'none',
      ],
    );

    await client.query('COMMIT');
    return { outcome: 'ok' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getFeedbackReportById(
  pool: Pool | PoolClient,
  id: string,
): Promise<FeedbackReportRow | null> {
  const result = await pool.query<FeedbackReportRow>(
    `SELECT * FROM feedback_reports WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Browser remediation for a terminal row. Called only while the report's Jira
 * advisory lock is held. Attempts reset, but create/attachment fences remain,
 * so retrying an uncertain external operation can only reconcile, never repeat.
 */
export async function reclaimFailedReportForRetry(
  pool: Pool | PoolClient,
  id: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE feedback_reports
        SET status = 'pending',
            attempts = 0,
            last_error = 'manual_retry_requested',
            updated_at = now()
      WHERE id = $1 AND status = 'failed'
      RETURNING id`,
    [id],
  );
  return result.rowCount === 1;
}

/**
 * Hold a session-scoped lock across Jira I/O for one durable report. A replay
 * waits for the original request, reloads its row, and returns that outcome
 * instead of racing search-before-create against the same Jira label.
 */
export async function withFeedbackReportSyncLock<T>(
  pool: Pool,
  id: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(
      `SELECT pg_advisory_lock(hashtext('feedback-report-sync'), hashtext($1))`,
      [id],
    );
    return await work(client);
  } finally {
    await client
      .query(`SELECT pg_advisory_unlock(hashtext('feedback-report-sync'), hashtext($1))`, [id])
      .catch(() => undefined);
    client.release();
  }
}

/** Store the created/found issue key as soon as it is known (crash safety). */
export async function markReportTicketKey(
  pool: Pool | PoolClient,
  id: string,
  key: string,
): Promise<void> {
  await pool.query(
    `UPDATE feedback_reports SET
       jira_ticket_key = $2,
       jira_create_state = 'completed',
       updated_at = now()
     WHERE id = $1`,
    [id, key],
  );
}

/** Persist a stable fence before the create request can leave the process. */
export async function markReportCreateInFlight(
  pool: Pool | PoolClient,
  id: string,
  token: string,
): Promise<void> {
  await pool.query(
    `UPDATE feedback_reports SET
       jira_create_state = 'in_flight',
       jira_create_token = COALESCE(jira_create_token, $2),
       updated_at = now()
     WHERE id = $1`,
    [id, token],
  );
}

/** Ambiguous create response: preserve the fence so no later path can create. */
export async function markReportCreateUncertain(
  pool: Pool | PoolClient,
  id: string,
  error: string,
): Promise<void> {
  await pool.query(
    `UPDATE feedback_reports SET
       jira_create_state = 'uncertain',
       last_error = $2,
       updated_at = now()
     WHERE id = $1`,
    [id, error.slice(0, LAST_ERROR_MAX)],
  );
}

/**
 * A stale empty search after an ambiguous create is not permission to create.
 * Back off through bounded retries and end in an operator-visible terminal
 * state that can be reconciled manually.
 */
export async function recordReportCreateReconcileMiss(
  pool: Pool | PoolClient,
  id: string,
  maxAttempts: number,
): Promise<void> {
  await pool.query(
    `UPDATE feedback_reports SET
       jira_create_state = 'uncertain',
       attempts = attempts + 1,
       status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending_retry' END,
       last_error = 'jira_create_uncertain_operator_reconciliation_required',
       updated_at = now()
     WHERE id = $1`,
    [id, maxAttempts],
  );
}

/**
 * Full success: synced, with new unredacted screenshots retained privately.
 * A legacy `uncertain` attachment state is historical evidence that the old
 * schema cannot resolve, so completing Jira reconciliation must preserve it.
 */
export async function markReportSynced(pool: Pool | PoolClient, id: string): Promise<void> {
  await pool.query(
    `UPDATE feedback_reports SET
       status = 'synced',
       attachment_state = CASE
         WHEN screenshot_bytes IS NULL THEN 'none'
         WHEN attachment_state = 'uncertain' THEN 'uncertain'
         ELSE 'retained_private'
       END,
       last_error = NULL,
       updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

/**
 * Record a failed sync cycle. `bumpAttempts` counts a COMPLETED failed attempt
 * (search/create/reconciliation actually failed); parking an unconfigured submission
 * does not burn an attempt. A bump that reaches maxAttempts goes terminal
 * `failed` — exactly at the boundary, never stranding at an unclaimable
 * pending_retry.
 */
export async function recordReportFailure(
  pool: Pool | PoolClient,
  id: string,
  outcome: { error: string; bumpAttempts: boolean; maxAttempts: number },
): Promise<void> {
  await pool.query(
    `UPDATE feedback_reports SET
       attempts = attempts + CASE WHEN $2 THEN 1 ELSE 0 END,
       status = CASE
         WHEN $2 AND attempts + 1 >= $3 THEN 'failed'
         ELSE 'pending_retry'
       END,
       last_error = $4,
       updated_at = now()
     WHERE id = $1`,
    [id, outcome.bumpAttempts, outcome.maxAttempts, outcome.error.slice(0, LAST_ERROR_MAX)],
  );
}

/**
 * Atomically claim a batch for the retry sweep: one UPDATE over a
 * FOR UPDATE SKIP LOCKED subquery, so two workers can never double-claim.
 * Claimed rows flip to 'pending' (the same state as a fresh submission) so a
 * crashed worker's rows re-enter recovery via the stale-pending window;
 * attempts are NOT bumped at claim time. The UPDATE bumps updated_at so a
 * concurrent sweep can't steal the row back through the stale window.
 */
export async function claimRetryBatch(
  pool: Pool,
  opts: { maxAttempts: number; stalePendingMinutes: number; batchLimit: number },
): Promise<FeedbackReportRow[]> {
  const result = await pool.query<FeedbackReportRow>(
    `UPDATE feedback_reports
        SET status = 'pending', updated_at = now()
      WHERE id IN (
        SELECT id
          FROM feedback_reports
         WHERE (status = 'pending_retry' AND attempts < $1)
            OR (status = 'pending' AND updated_at < now() - ($2 * interval '1 minute'))
         ORDER BY updated_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [opts.maxAttempts, opts.stalePendingMinutes, opts.batchLimit],
  );
  return result.rows;
}
