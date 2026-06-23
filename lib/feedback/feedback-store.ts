/**
 * Durable storage for feedback submissions. This is the backstop that makes the
 * spec's "never silently drop a submission" guarantee real: the API persists
 * here BEFORE attempting the Composio → Google Sheet mirror, and upserts by
 * submission_id so a retry of the same submission updates the existing row
 * instead of creating a duplicate.
 */

import type { PoolClient } from 'pg';

import pool from '@/lib/db';
import type {
  FeedbackSheetSyncStatus,
  FeedbackSubmissionRecord,
} from './types';

let ensured = false;

/**
 * Create the table on demand (mirrors app/api/early-access/route.ts). The
 * migration in migrations/20260623000000_feedback_submissions.sql is the
 * canonical schema; this keeps the feature working on databases where the
 * migration has not been run yet (e.g. local dev). Idempotent.
 */
export async function ensureFeedbackTable(): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_submissions (
      id BIGSERIAL PRIMARY KEY,
      submission_id TEXT UNIQUE NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'unauthenticated',
      auth_state TEXT NOT NULL DEFAULT 'unauthenticated',
      user_id TEXT,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      comment TEXT NOT NULL,
      page_url TEXT,
      user_agent TEXT,
      viewport TEXT,
      console_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      environment TEXT NOT NULL DEFAULT 'unknown',
      ip_hash TEXT,
      screenshot_bytes BYTEA,
      screenshot_mime TEXT,
      screenshot_link TEXT,
      sheet_sync_status TEXT NOT NULL DEFAULT 'pending',
      sheet_sync_error TEXT,
      sheet_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created_at ON feedback_submissions (created_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_feedback_submissions_sync_status ON feedback_submissions (sheet_sync_status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_feedback_submissions_tenant ON feedback_submissions (tenant_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_feedback_submissions_ip_hash_created ON feedback_submissions (ip_hash, created_at DESC)`,
  );
  ensured = true;
}

/** Reset memoization — for tests that swap the pool/schema. */
export function resetFeedbackTableEnsuredForTests(): void {
  ensured = false;
}

/**
 * Insert (or update on retry) the durable record, keyed by submission_id.
 *
 * Identity columns (tenant_id, auth_state, user_id, ip_hash) are set ONCE at
 * insert and deliberately NOT overwritten on conflict: the submission_id is a
 * client-supplied value, so allowing a later re-POST to rewrite the owner would
 * let one origin downgrade/tamper another submission's identity. Content fields
 * are refreshed so an edited retry is honored.
 *
 * Returns `isNew` (first time we saw this id — lets callers avoid re-counting a
 * retry against rate limits) and `sheetSyncStatus` (the row's mirror status as it
 * stood BEFORE this call — unchanged here — so the caller can skip a Sheet append
 * that already succeeded and avoid duplicate rows).
 */
export async function upsertFeedbackSubmission(
  record: FeedbackSubmissionRecord,
): Promise<{ isNew: boolean; sheetSyncStatus: FeedbackSheetSyncStatus }> {
  const result = await pool.query<{ inserted: boolean; sheet_sync_status: FeedbackSheetSyncStatus }>(
    `
      INSERT INTO feedback_submissions (
        submission_id, tenant_id, auth_state, user_id, category, severity,
        comment, page_url, user_agent, viewport, console_errors, environment,
        ip_hash, screenshot_bytes, screenshot_mime, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)
      ON CONFLICT (submission_id) DO UPDATE SET
        -- identity columns intentionally NOT updated (set once at insert)
        category = EXCLUDED.category,
        severity = EXCLUDED.severity,
        comment = EXCLUDED.comment,
        page_url = EXCLUDED.page_url,
        user_agent = EXCLUDED.user_agent,
        viewport = EXCLUDED.viewport,
        console_errors = EXCLUDED.console_errors,
        environment = EXCLUDED.environment,
        -- only overwrite a stored screenshot when the retry actually carries one
        screenshot_bytes = COALESCE(EXCLUDED.screenshot_bytes, feedback_submissions.screenshot_bytes),
        screenshot_mime = COALESCE(EXCLUDED.screenshot_mime, feedback_submissions.screenshot_mime),
        updated_at = now()
      RETURNING (xmax = 0) AS inserted, sheet_sync_status
    `,
    [
      record.submissionId,
      record.tenantId,
      record.authState,
      record.userId,
      record.category,
      record.severity,
      record.comment,
      record.pageUrl,
      record.userAgent,
      record.viewport,
      JSON.stringify(record.consoleErrors ?? []),
      record.environment,
      record.ipHash,
      record.screenshot?.bytes ?? null,
      record.screenshot?.mime ?? null,
      record.createdAtIso,
    ],
  );
  const row = result.rows[0];
  return {
    isNew: row?.inserted === true,
    sheetSyncStatus: row?.sheet_sync_status ?? 'pending',
  };
}

/** Record the outcome of the Google Sheet mirror attempt. */
export async function recordSheetSync(
  submissionId: string,
  outcome: {
    status: FeedbackSheetSyncStatus;
    screenshotLink?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await pool.query(
    `
      UPDATE feedback_submissions SET
        sheet_sync_status = $2,
        screenshot_link = COALESCE($3, screenshot_link),
        sheet_sync_error = $4,
        sheet_synced_at = CASE WHEN $2 = 'synced' THEN now() ELSE sheet_synced_at END,
        updated_at = now()
      WHERE submission_id = $1
    `,
    [submissionId, outcome.status, outcome.screenshotLink ?? null, outcome.error ?? null],
  );
}

/**
 * Count OTHER recent submissions from an origin within the trailing window —
 * used for abuse throttling on the public endpoint (mirrors the count-recent-rows
 * pattern in app/api/auth/forgot-password/route.ts).
 *
 * Notes:
 *  - `IS NOT DISTINCT FROM` so header-less requests (ipHash === null) all share a
 *    single bucket rather than each being unlimited.
 *  - excludes the current submission_id so a retry is never throttled by its own
 *    already-persisted row.
 *  - does NOT swallow DB errors: the caller wraps this in try/catch and fails the
 *    request closed (a broken DB must not silently disable the limit).
 */
export async function countRecentSubmissions(
  identity: { ipHash: string | null; excludeSubmissionId?: string },
  windowMinutes: number,
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `
      SELECT COUNT(*)::int AS count
        FROM feedback_submissions
       WHERE ip_hash IS NOT DISTINCT FROM $1
         AND submission_id <> $2
         AND created_at > now() - ($3 || ' minutes')::interval
    `,
    [identity.ipHash, identity.excludeSubmissionId ?? '', String(windowMinutes)],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Fetch a stored screenshot for the app-served fallback link. */
export async function getScreenshot(
  submissionId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const result = await pool.query<{ screenshot_bytes: Buffer | null; screenshot_mime: string | null }>(
    `SELECT screenshot_bytes, screenshot_mime FROM feedback_submissions WHERE submission_id = $1 LIMIT 1`,
    [submissionId],
  );
  const row = result.rows[0];
  if (!row?.screenshot_bytes || !row.screenshot_mime) return null;
  return { bytes: row.screenshot_bytes, mime: row.screenshot_mime };
}

/** Test seam: run an arbitrary query within a client (used by the test harness). */
export async function withFeedbackClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
