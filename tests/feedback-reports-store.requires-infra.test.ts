import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { requireDbEnvOrSkip } from './helpers/requires-infra';
import {
  claimRetryBatch,
  ensureFeedbackReportsTable,
  insertReportWithLimits,
  markReportSynced,
  markReportTicketKey,
  recordReportFailure,
  resetFeedbackReportsEnsuredForTests,
  type FeedbackReportRecord,
} from '../backend/feedback/report-store';

// Live-schema proof for the SC-70 feedback_reports store. The self-contained
// tests exercise the logic with fakes; this file executes the real SQL —
// transactional rate-limit/dedup, the FOR UPDATE SKIP LOCKED claim, the
// attempts boundary, and the bytes-NULLing sync mark — against a throwaway
// schema (search_path pinned per-pool) so a prod database is never touched
// beyond CREATE SCHEMA/DROP SCHEMA of a uniquely-named test schema.

function record(id: string, overrides: Partial<FeedbackReportRecord> = {}): FeedbackReportRecord {
  return {
    id,
    tenantId: 't1',
    submitterId: 'u1',
    submitterEmail: 'jo@acme.co',
    submitterName: 'Jo',
    customerSlug: 'acme',
    category: 'bug',
    impact: 'p2_feature_degraded',
    title: `title-${id}`,
    description: `description-${id}`,
    screenshot: null,
    ...overrides,
  };
}

test('feedback_reports store: limits, claim, boundary, and sync against real Postgres', async (t) => {
  if (!requireDbEnvOrSkip(t)) return;

  const schema = `feedback_reports_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 1,
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);

  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 4,
    options: `-c search_path="${schema}"`,
  });

  try {
    resetFeedbackReportsEnsuredForTests();
    await ensureFeedbackReportsTable(pool);

    // --- rate limit boundary: limit-th passes, limit+1 rejects, dedup 429s ---
    const limits = { userRateLimitPerHour: 3, dedupWindowSeconds: 60 };
    for (let i = 1; i <= 3; i += 1) {
      const outcome = await insertReportWithLimits(pool, record(`r${i}`), limits);
      assert.deepEqual(outcome, { outcome: 'ok' }, `insert ${i} of limit 3 must pass`);
    }
    assert.deepEqual(await insertReportWithLimits(pool, record('r4'), limits), {
      outcome: 'rate_limited',
    });
    // Different submitter is its own bucket.
    assert.deepEqual(
      await insertReportWithLimits(pool, record('r5', { submitterId: 'u2' }), limits),
      { outcome: 'ok' },
    );
    // Rapid duplicate (same title+description in the window) for that submitter.
    assert.deepEqual(
      await insertReportWithLimits(
        pool,
        record('r6', { submitterId: 'u2', title: 'title-r5', description: 'description-r5' }),
        limits,
      ),
      { outcome: 'duplicate' },
    );
    // The rolled-back over-limit insert must not have left a row behind.
    const r4 = await pool.query(`SELECT 1 FROM feedback_reports WHERE id = 'r4'`);
    assert.equal(r4.rowCount, 0);

    // --- claim: only pending_retry-under-max and stale pending rows ---
    await pool.query(
      `UPDATE feedback_reports SET status = 'pending_retry', attempts = 1 WHERE id = 'r1'`,
    );
    await pool.query(
      `UPDATE feedback_reports SET status = 'pending_retry', attempts = 5 WHERE id = 'r2'`,
    );
    // r3 stays fresh 'pending' (in-flight inline path — must NOT be claimed);
    // r5 becomes a stale 'pending' (crash recovery — MUST be claimed).
    await pool.query(
      `UPDATE feedback_reports SET updated_at = now() - interval '20 minutes' WHERE id = 'r5'`,
    );
    const claimed = await claimRetryBatch(pool, {
      maxAttempts: 5,
      stalePendingMinutes: 15,
      batchLimit: 10,
    });
    assert.deepEqual(claimed.map((row) => row.id).sort(), ['r1', 'r5']);
    for (const row of claimed) assert.equal(row.status, 'pending');
    // The claim bumped updated_at, so an immediate second sweep steals nothing.
    const second = await claimRetryBatch(pool, {
      maxAttempts: 5,
      stalePendingMinutes: 15,
      batchLimit: 10,
    });
    assert.equal(second.length, 0);

    // --- attempts boundary: a bump landing exactly at max goes terminal failed ---
    await pool.query(
      `UPDATE feedback_reports SET status = 'pending_retry', attempts = 4 WHERE id = 'r1'`,
    );
    await recordReportFailure(pool, 'r1', { error: 'boom', bumpAttempts: true, maxAttempts: 5 });
    const r1 = await pool.query(
      `SELECT status, attempts, last_error FROM feedback_reports WHERE id = 'r1'`,
    );
    assert.equal(r1.rows[0].status, 'failed');
    assert.equal(r1.rows[0].attempts, 5);
    assert.equal(r1.rows[0].last_error, 'boom');
    // Below the boundary it stays retryable.
    await recordReportFailure(pool, 'r5', { error: 'e', bumpAttempts: true, maxAttempts: 5 });
    const r5 = await pool.query(`SELECT status, attempts FROM feedback_reports WHERE id = 'r5'`);
    assert.equal(r5.rows[0].status, 'pending_retry');
    assert.equal(r5.rows[0].attempts, 1);
    // Parking without a completed attempt must not bump.
    await recordReportFailure(pool, 'r3', {
      error: 'jira_not_configured',
      bumpAttempts: false,
      maxAttempts: 5,
    });
    const r3 = await pool.query(`SELECT status, attempts FROM feedback_reports WHERE id = 'r3'`);
    assert.equal(r3.rows[0].status, 'pending_retry');
    assert.equal(r3.rows[0].attempts, 0);

    // --- ticket key + synced: key persists, bytes are NULLed on sync ---
    await pool.query(
      `UPDATE feedback_reports
          SET screenshot_bytes = $1, screenshot_mime = 'image/png'
        WHERE id = 'r3'`,
      [Buffer.from('img-bytes')],
    );
    await markReportTicketKey(pool, 'r3', 'AA-123');
    await markReportSynced(pool, 'r3');
    const synced = await pool.query(
      `SELECT status, jira_ticket_key, screenshot_bytes, screenshot_mime, last_error
         FROM feedback_reports WHERE id = 'r3'`,
    );
    assert.equal(synced.rows[0].status, 'synced');
    assert.equal(synced.rows[0].jira_ticket_key, 'AA-123');
    assert.equal(synced.rows[0].screenshot_bytes, null);
    assert.equal(synced.rows[0].screenshot_mime, null);
    assert.equal(synced.rows[0].last_error, null);

    // --- attach-fail keeps screenshot bytes (the sweep re-attaches from these
    // columns): a row with a stored ticket key + screenshot bytes that then
    // fails (the attach step, specifically) must retain BOTH columns — the
    // recordReportFailure UPDATE only ever touches status/attempts/last_error,
    // never screenshot_bytes/screenshot_mime. ---
    await insertReportWithLimits(
      pool,
      record('r7', {
        submitterId: 'u3', // fresh bucket — u1/u2 are already at/near the test's rate-limit cap
        screenshot: { bytes: Buffer.from('attach-me-bytes'), mime: 'image/jpeg' },
      }),
      limits,
    );
    await markReportTicketKey(pool, 'r7', 'AA-456');
    await recordReportFailure(pool, 'r7', {
      error: 'jira attach failed (HTTP 500)',
      bumpAttempts: true,
      maxAttempts: 5,
    });
    const attachFailed = await pool.query(
      `SELECT status, attempts, jira_ticket_key, screenshot_bytes, screenshot_mime, last_error
         FROM feedback_reports WHERE id = 'r7'`,
    );
    assert.equal(attachFailed.rows[0].status, 'pending_retry');
    assert.equal(attachFailed.rows[0].attempts, 1);
    assert.equal(attachFailed.rows[0].jira_ticket_key, 'AA-456');
    assert.deepEqual(
      Buffer.from(attachFailed.rows[0].screenshot_bytes),
      Buffer.from('attach-me-bytes'),
      'screenshot bytes must survive an attach failure so the sweep can retry the attach',
    );
    assert.equal(attachFailed.rows[0].screenshot_mime, 'image/jpeg');
    assert.equal(attachFailed.rows[0].last_error, 'jira attach failed (HTTP 500)');
  } finally {
    resetFeedbackReportsEnsuredForTests();
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
