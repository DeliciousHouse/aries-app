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

export interface FeedbackReportRecord {
  id: string;
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
  | { outcome: 'duplicate' };

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
 * Rate limit → dedup → INSERT → post-insert re-count, all in ONE transaction.
 *
 * INVARIANT (SC-70): the rate limit runs BEFORE persisting; a rapid duplicate
 * (same title+description inside the dedup window) is a 429, not a second row.
 * The count-then-insert race under parallel bursts is narrowed by re-counting
 * after the insert inside the same transaction and rolling back over-limit
 * inserts. Honest residual: under READ COMMITTED two concurrent transactions
 * that both commit before either re-count observes the other can still land
 * limit+1 rows in a photo-finish; the window is one statement wide and the
 * limit is advisory abuse protection, not a billing boundary.
 */
export async function insertReportWithLimits(
  pool: Pool,
  record: FeedbackReportRecord,
  limits: { userRateLimitPerHour: number; dedupWindowSeconds: number },
): Promise<InsertReportOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
         id, submitter_type, tenant_id, submitter_id, submitter_email, submitter_name,
         customer_slug, category, impact, title, description,
         screenshot_bytes, screenshot_mime, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')`,
      [
        record.id,
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
      ],
    );

    const after = await countRecentForSubmitter(client, record.tenantId, record.submitterId);
    if (after > limits.userRateLimitPerHour) {
      await client.query('ROLLBACK');
      return { outcome: 'rate_limited' };
    }

    await client.query('COMMIT');
    return { outcome: 'ok' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Store the created/found issue key as soon as it is known (crash safety). */
export async function markReportTicketKey(pool: Pool, id: string, key: string): Promise<void> {
  await pool.query(
    `UPDATE feedback_reports SET jira_ticket_key = $2, updated_at = now() WHERE id = $1`,
    [id, key],
  );
}

/** Full success: synced, screenshot bytes NULLed, error cleared. */
export async function markReportSynced(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE feedback_reports SET
       status = 'synced',
       screenshot_bytes = NULL,
       screenshot_mime = NULL,
       last_error = NULL,
       updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

/**
 * Record a failed sync cycle. `bumpAttempts` counts a COMPLETED failed attempt
 * (search/create/attach actually failed); parking an unconfigured submission
 * does not burn an attempt. A bump that reaches maxAttempts goes terminal
 * `failed` — exactly at the boundary, never stranding at an unclaimable
 * pending_retry.
 */
export async function recordReportFailure(
  pool: Pool,
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
