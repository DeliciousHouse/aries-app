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
import { submitFeedbackReport } from '../backend/feedback/submit-report';

// Live-schema proof for the SC-70 feedback_reports store. The self-contained
// tests exercise the logic with fakes; this file executes the real SQL —
// transactional rate-limit/dedup, the FOR UPDATE SKIP LOCKED claim, the
// attempts boundary, and the bytes-NULLing sync mark — against a throwaway
// schema (search_path pinned per-pool) so a prod database is never touched
// beyond CREATE SCHEMA/DROP SCHEMA of a uniquely-named test schema.

function record(id: string, overrides: Partial<FeedbackReportRecord> = {}): FeedbackReportRecord {
  return {
    id,
    submitterType: 'authenticated',
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
    requestFingerprint: `fingerprint-${id}`,
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
    max: 16,
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

    // Anonymous traffic uses the same transaction-safe limiter, keyed by the
    // server-generated hashed-IP submitter id rather than a fake user record.
    const anonymous = {
      submitterType: 'anonymous' as const,
      tenantId: 'anonymous',
      submitterId: 'anonymous:stable-ip-hash',
      submitterEmail: null,
      submitterName: null,
      customerSlug: 'anonymous',
    };
    const anonymousLimits = { userRateLimitPerHour: 2, dedupWindowSeconds: 60 };
    assert.deepEqual(
      await insertReportWithLimits(pool, record('anon-1', anonymous), anonymousLimits),
      { outcome: 'ok' },
    );
    assert.deepEqual(
      await insertReportWithLimits(pool, record('anon-2', anonymous), anonymousLimits),
      { outcome: 'ok' },
    );
    assert.deepEqual(
      await insertReportWithLimits(pool, record('anon-3', anonymous), anonymousLimits),
      { outcome: 'rate_limited' },
    );
    const storedAnonymous = await pool.query(
      `SELECT submitter_type, submitter_email, submitter_name
         FROM feedback_reports WHERE id = 'anon-1'`,
    );
    assert.deepEqual(storedAnonymous.rows[0], {
      submitter_type: 'anonymous',
      submitter_email: null,
      submitter_name: null,
    });

    // Coordinate every contender past its initial SELECTs before any INSERT
    // can commit. Without per-submitter serialization this trigger makes the
    // READ COMMITTED race deterministic: all callers observe the same stale
    // count/dedup snapshot and can overrun the cap or persist duplicates.
    await pool.query(`
      CREATE FUNCTION pause_feedback_report_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.15);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER pause_feedback_report_insert
        BEFORE INSERT ON feedback_reports
        FOR EACH ROW EXECUTE FUNCTION pause_feedback_report_insert()
    `);

    async function burst(
      records: FeedbackReportRecord[],
      burstLimits: { userRateLimitPerHour: number; dedupWindowSeconds: number },
    ) {
      let release!: () => void;
      const start = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = records.map(async (item) => {
        await start;
        return insertReportWithLimits(pool, item, burstLimits);
      });
      release();
      return Promise.all(pending);
    }

    const capBurst = await burst(
      Array.from({ length: 12 }, (_, index) =>
        record(`cap-burst-${index}`, { submitterId: 'burst-cap-user' }),
      ),
      { userRateLimitPerHour: 3, dedupWindowSeconds: 60 },
    );
    assert.equal(capBurst.filter(({ outcome }) => outcome === 'ok').length, 3);
    assert.equal(capBurst.filter(({ outcome }) => outcome === 'rate_limited').length, 9);
    const capRows = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM feedback_reports WHERE submitter_id = 'burst-cap-user'`,
    );
    assert.equal(capRows.rows[0].count, 3, 'a concurrent burst must never persist above the cap');

    const duplicateBurst = await burst(
      Array.from({ length: 8 }, (_, index) =>
        record(`dedup-burst-${index}`, {
          submitterId: 'burst-dedup-user',
          title: 'same concurrent title',
          description: 'same concurrent description',
        }),
      ),
      { userRateLimitPerHour: 20, dedupWindowSeconds: 60 },
    );
    assert.equal(duplicateBurst.filter(({ outcome }) => outcome === 'ok').length, 1);
    assert.equal(duplicateBurst.filter(({ outcome }) => outcome === 'duplicate').length, 7);
    const duplicateRows = await pool.query<{ rows: number; jira_identities: number }>(
      `SELECT COUNT(*)::int AS rows, COUNT(DISTINCT id)::int AS jira_identities
         FROM feedback_reports WHERE submitter_id = 'burst-dedup-user'`,
    );
    assert.deepEqual(duplicateRows.rows[0], {
      rows: 1,
      jira_identities: 1,
    });

    const idempotencyId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const original = record(idempotencyId, {
      submitterId: 'idempotency-user',
      requestFingerprint: 'same-payload-fingerprint',
    });
    assert.deepEqual(
      await insertReportWithLimits(pool, original, {
        userRateLimitPerHour: 10,
        dedupWindowSeconds: 60,
      }),
      { outcome: 'ok' },
    );
    await pool.query(
      `UPDATE feedback_reports SET created_at = now() - interval '5 minutes' WHERE id = $1`,
      [idempotencyId],
    );
    const replay = await insertReportWithLimits(pool, original, {
      userRateLimitPerHour: 10,
      dedupWindowSeconds: 60,
    });
    assert.equal(replay.outcome, 'replay', 'the key must win after the content dedup window');
    if (replay.outcome === 'replay') assert.equal(replay.report.id, idempotencyId);

    const crossIdentity = await insertReportWithLimits(
      pool,
      { ...original, submitterId: 'other-user' },
      { userRateLimitPerHour: 10, dedupWindowSeconds: 60 },
    );
    assert.deepEqual(crossIdentity, { outcome: 'idempotency_conflict' });
    const changedPayload = await insertReportWithLimits(
      pool,
      { ...original, title: 'changed title', requestFingerprint: 'changed-payload-fingerprint' },
      { userRateLimitPerHour: 10, dedupWindowSeconds: 60 },
    );
    assert.deepEqual(changedPayload, { outcome: 'idempotency_conflict' });
    const idempotencyRows = await pool.query<{ rows: number; jira_identities: number }>(
      `SELECT COUNT(*)::int AS rows, COUNT(DISTINCT id)::int AS jira_identities
         FROM feedback_reports WHERE id = $1`,
      [idempotencyId],
    );
    assert.deepEqual(idempotencyRows.rows[0], { rows: 1, jira_identities: 1 });

    // End-to-end lost-ack replay: the first HTTP result is deliberately
    // ignored after Jira state is durably recorded. A retry well beyond the
    // content-dedup window must return that same row/key without a second sync.
    const lostAckId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    let jiraSyncCalls = 0;
    const submitDeps = {
      pool,
      ensureTable: async () => {},
      sync: async (report: { id: string }) => {
        jiraSyncCalls += 1;
        await markReportTicketKey(pool, report.id, 'AA-900');
        await markReportSynced(pool, report.id);
        return { status: 'synced' as const, ticketKey: 'AA-900' };
      },
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    };
    const lostAckInput = {
      idempotencyKey: lostAckId,
      category: 'bug' as const,
      impact: 'p2_feature_degraded' as const,
      title: 'lost acknowledgement',
      description: 'the first response never reached the browser',
      screenshot: null,
    };
    const submitter = {
      attribution: 'authenticated' as const,
      userId: 'lost-ack-user',
      email: 'jo@acme.co',
      name: 'Jo',
      tenantId: 't1',
      tenantSlug: 'acme',
    };
    const reportConfig = {
      jira: {
        baseUrl: 'https://example.atlassian.net',
        email: 'bot@example.com',
        apiToken: 'token',
        projectKey: 'AA',
        issueType: 'Bug',
      },
      maxImageBytes: 2_000_000,
      userRateLimitPerHour: 10,
      dedupWindowSeconds: 60,
      retryIntervalMinutes: 5,
      retryBatchLimit: 10,
      retryMaxAttempts: 5,
      stalePendingMinutes: 15,
    };
    await submitFeedbackReport(lostAckInput, submitter, reportConfig, submitDeps);
    await pool.query(
      `UPDATE feedback_reports SET created_at = now() - interval '5 minutes' WHERE id = $1`,
      [lostAckId],
    );
    const recovered = await submitFeedbackReport(lostAckInput, submitter, reportConfig, submitDeps);
    assert.equal(jiraSyncCalls, 1);
    assert.equal(recovered.httpStatus, 201);
    assert.equal(recovered.body.submission_id, lostAckId);
    assert.equal(recovered.body.jira_ticket_key, 'AA-900');
    const lostAckRows = await pool.query<{ rows: number }>(
      `SELECT COUNT(*)::int AS rows FROM feedback_reports WHERE id = $1`,
      [lostAckId],
    );
    assert.equal(lostAckRows.rows[0].rows, 1);

    // The harder lost-ack race: retry while request 1 has created/stored the
    // Jira key but has not returned or marked the row synced yet. The per-ID
    // sync lock must keep request 2 out of Jira until it can reload the result.
    const inFlightId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
    let inFlightSyncCalls = 0;
    let signalJiraCreated!: () => void;
    const jiraCreated = new Promise<void>((resolve) => {
      signalJiraCreated = resolve;
    });
    let releaseAcknowledgement!: () => void;
    const acknowledgementReleased = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    const inFlightDeps = {
      pool,
      ensureTable: async () => {},
      sync: async (report: { id: string }) => {
        inFlightSyncCalls += 1;
        await markReportTicketKey(pool, report.id, 'AA-901');
        signalJiraCreated();
        await acknowledgementReleased;
        await markReportSynced(pool, report.id);
        return { status: 'synced' as const, ticketKey: 'AA-901' };
      },
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    };
    const inFlightInput = { ...lostAckInput, idempotencyKey: inFlightId };
    const firstInFlight = submitFeedbackReport(inFlightInput, submitter, reportConfig, inFlightDeps);
    await jiraCreated;
    const replayInFlight = submitFeedbackReport(
      inFlightInput,
      submitter,
      reportConfig,
      inFlightDeps,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const callsBeforeAcknowledgement = inFlightSyncCalls;
    releaseAcknowledgement();
    const [firstInFlightResult, replayInFlightResult] = await Promise.all([
      firstInFlight,
      replayInFlight,
    ]);
    assert.equal(callsBeforeAcknowledgement, 1, 'the replay must wait outside Jira');
    assert.equal(inFlightSyncCalls, 1, 'the replay must never run a second Jira cycle');
    assert.deepEqual(replayInFlightResult, firstInFlightResult);
    assert.equal(replayInFlightResult.body.jira_ticket_key, 'AA-901');

    // The sync lock must not reserve one pool connection while asking the same
    // pool for another. A max=1 pool is both a regression proof and a useful
    // bound for low-resource deployments.
    const singleClientPool = new pg.Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: 1,
      connectionTimeoutMillis: 300,
      options: `-c search_path="${schema}"`,
    });
    try {
      const singleClientId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
      const singleClientResult = await submitFeedbackReport(
        { ...lostAckInput, idempotencyKey: singleClientId, title: 'single-client sync lock' },
        submitter,
        reportConfig,
        {
          pool: singleClientPool,
          ensureTable: async () => {},
          sync: async (report, _config, store) => {
            await store.markTicketKey(report.id, 'AA-902');
            await store.markSynced(report.id);
            return { status: 'synced' as const, ticketKey: 'AA-902' };
          },
          now: () => new Date('2026-07-03T00:00:00.000Z'),
        },
      );
      assert.equal(singleClientResult.httpStatus, 201);
      assert.equal(singleClientResult.body.jira_ticket_key, 'AA-902');
    } finally {
      await singleClientPool.end();
    }

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
