import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';

import type { FeedbackReportConfig } from '../backend/feedback/report-config';
import type {
  FeedbackReportRecord,
  FeedbackReportRow,
} from '../backend/feedback/report-store';
import {
  submitFeedbackReport,
  type ReportSubmitter,
  type SubmitReportDeps,
} from '../backend/feedback/submit-report';

const FAKE_POOL = {} as unknown as Pool;
const FAKE_CLIENT = {} as unknown as PoolClient;
const IDEMPOTENCY_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function config(overrides: Partial<FeedbackReportConfig> = {}): FeedbackReportConfig {
  return {
    jira: {
      baseUrl: 'https://example.atlassian.net',
      email: 'bot@example.com',
      apiToken: 'tok',
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
    ...overrides,
  };
}

const SUBMITTER: ReportSubmitter = {
  attribution: 'authenticated',
  userId: 'user-1',
  email: 'jo@acme.co',
  name: 'Jo',
  tenantId: '15',
  tenantSlug: 'acme-co',
};

const INPUT = {
  idempotencyKey: IDEMPOTENCY_KEY,
  category: 'bug' as const,
  impact: 'p2_feature_degraded' as const,
  title: 'Broken button',
  description: 'It does nothing.',
  screenshot: null as unknown,
};

function deps(overrides: Partial<SubmitReportDeps> = {}): SubmitReportDeps {
  return {
    pool: FAKE_POOL,
    ensureTable: async () => {},
    insert: async () => ({ outcome: 'ok' as const }),
    sync: async () => ({ status: 'synced' as const, ticketKey: 'AA-1' }),
    getById: async () => null,
    withSyncLock: async (_pool, _id, work) => work(FAKE_CLIENT),
    now: () => new Date('2026-07-03T00:00:00.000Z'),
    ...overrides,
  };
}

function persistedRow(
  record: FeedbackReportRecord,
  overrides: Partial<FeedbackReportRow> = {},
): FeedbackReportRow {
  return {
    id: record.id,
    request_fingerprint: record.requestFingerprint,
    submitter_type: record.submitterType,
    tenant_id: record.tenantId,
    submitter_id: record.submitterId,
    submitter_email: record.submitterEmail,
    submitter_name: record.submitterName,
    customer_slug: record.customerSlug,
    category: record.category,
    impact: record.impact,
    title: record.title,
    description: record.description,
    screenshot_bytes: record.screenshot?.bytes ?? null,
    screenshot_mime: record.screenshot?.mime ?? null,
    jira_ticket_key: null,
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: new Date('2026-07-03T00:00:00.000Z'),
    updated_at: new Date('2026-07-03T00:00:00.000Z'),
    ...overrides,
  };
}

test('full success is 201 with the uniform four-field body', async () => {
  const result = await submitFeedbackReport(INPUT, SUBMITTER, config(), deps());
  assert.equal(result.httpStatus, 201);
  assert.deepEqual(result.body, {
    submission_id: IDEMPOTENCY_KEY,
    jira_ticket_key: 'AA-1',
    status: 'synced',
    screenshot_discarded: null,
  });
});

test('INVARIANT persist-first: a sync that throws still returns 202 — the row is already committed', async () => {
  let inserted: FeedbackReportRecord | null = null;
  const result = await submitFeedbackReport(
    INPUT,
    SUBMITTER,
    config(),
    deps({
      insert: async (_pool, record) => {
        inserted = record;
        return { outcome: 'ok' };
      },
      sync: async () => {
        throw new Error('store write exploded mid-sync');
      },
    }),
  );
  assert.ok(inserted, 'row must be persisted before any Jira work');
  assert.equal(result.httpStatus, 202);
  assert.deepEqual(result.body, {
    submission_id: IDEMPOTENCY_KEY,
    jira_ticket_key: null,
    status: 'pending_retry',
    screenshot_discarded: null,
  });
});

test('a Jira failure at retryMaxAttempts=1 reports the row as terminally failed', async () => {
  const result = await submitFeedbackReport(
    INPUT,
    SUBMITTER,
    config({ retryMaxAttempts: 1 }),
    deps({
      sync: async () => ({ status: 'failed', ticketKey: null }),
    }),
  );

  assert.equal(result.httpStatus, 202);
  assert.deepEqual(result.body, {
    submission_id: IDEMPOTENCY_KEY,
    jira_ticket_key: null,
    status: 'failed',
    screenshot_discarded: null,
  });
});

test('identity comes from the session argument, never the body', async () => {
  let inserted: FeedbackReportRecord | null = null;
  await submitFeedbackReport(
    INPUT,
    SUBMITTER,
    config(),
    deps({
      insert: async (_pool, record) => {
        inserted = record;
        return { outcome: 'ok' };
      },
      sync: async () => ({ status: 'pending_retry', ticketKey: null }),
    }),
  );
  const record = inserted as unknown as FeedbackReportRecord;
  assert.equal(record.submitterId, 'user-1');
  assert.equal(record.tenantId, '15');
  assert.equal(record.customerSlug, 'acme-co');
  assert.equal(record.submitterEmail, 'jo@acme.co');
  assert.equal(record.submitterType, 'authenticated');
});

test('anonymous reports persist the hashed rate-limit identity before Jira delivery', async () => {
  let inserted: FeedbackReportRecord | null = null;
  const result = await submitFeedbackReport(
    INPUT,
    {
      attribution: 'anonymous',
      userId: 'anonymous:hashed-client-ip',
      email: null,
      name: null,
      tenantId: 'anonymous',
      tenantSlug: 'anonymous',
    },
    config(),
    deps({
      insert: async (_pool, record) => {
        inserted = record;
        return { outcome: 'ok' };
      },
      sync: async () => ({ status: 'pending_retry', ticketKey: null }),
    }),
  );

  const record = inserted as unknown as FeedbackReportRecord;
  assert.equal(record.submitterType, 'anonymous');
  assert.equal(record.submitterId, 'anonymous:hashed-client-ip');
  assert.equal(record.submitterName, null);
  assert.equal(record.submitterEmail, null);
  assert.equal(record.customerSlug, 'unknown');
  assert.equal(result.httpStatus, 202, 'the committed row must survive deferred Jira delivery');
  assert.equal(result.body.submission_id, IDEMPOTENCY_KEY);
});

test('rate-limited and duplicate inserts are 429 with distinct messages and no sync call', async () => {
  let syncCalls = 0;
  for (const outcome of ['rate_limited', 'duplicate'] as const) {
    const result = await submitFeedbackReport(
      INPUT,
      SUBMITTER,
      config(),
      deps({
        insert: async () => ({ outcome }),
        sync: async () => {
          syncCalls += 1;
          return { status: 'synced', ticketKey: 'AA-1' };
        },
      }),
    );
    assert.equal(result.httpStatus, 429);
    assert.equal(result.body.status, 'rate_limited');
    assert.ok(result.body.error);
  }
  assert.equal(syncCalls, 0, 'a throttled submission must not reach Jira');
});

test('persist failure is a retryable 503 and never reaches Jira', async () => {
  let syncCalls = 0;
  const result = await submitFeedbackReport(
    INPUT,
    SUBMITTER,
    config(),
    deps({
      insert: async () => {
        throw new Error('db down');
      },
      sync: async () => {
        syncCalls += 1;
        return { status: 'synced', ticketKey: 'AA-1' };
      },
    }),
  );
  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.status, 'persist_failed');
  assert.equal(syncCalls, 0);
});

test('a bad screenshot never sinks the report: discarded reason rides the success body', async () => {
  let inserted: FeedbackReportRecord | null = null;
  const result = await submitFeedbackReport(
    { ...INPUT, screenshot: { base64: '!!!', mime: 'image/png' } },
    SUBMITTER,
    config(),
    deps({
      insert: async (_pool, record) => {
        inserted = record;
        return { outcome: 'ok' };
      },
    }),
  );
  assert.equal(result.httpStatus, 201);
  assert.equal(result.body.screenshot_discarded, 'invalid_base64');
  assert.equal((inserted as unknown as FeedbackReportRecord).screenshot, null);
});

test('an oversized screenshot is discarded per config cap, report still succeeds', async () => {
  const big = Buffer.alloc(64, 1).toString('base64');
  const result = await submitFeedbackReport(
    { ...INPUT, screenshot: { base64: big, mime: 'image/png' } },
    SUBMITTER,
    config({ maxImageBytes: 16 }),
    deps(),
  );
  assert.equal(result.httpStatus, 201);
  assert.equal(result.body.screenshot_discarded, 'too_large');
});

test('attach-still-syncing: pending_retry WITH a key is 201 (link known, attachment heals)', async () => {
  const result = await submitFeedbackReport(
    INPUT,
    SUBMITTER,
    config(),
    deps({ sync: async () => ({ status: 'pending_retry', ticketKey: 'AA-5' }) }),
  );
  assert.equal(result.httpStatus, 201);
  assert.equal(result.body.jira_ticket_key, 'AA-5');
  assert.equal(result.body.status, 'pending_retry');
});

test('Jira unconfigured / failed create is 202 parked with the uniform shape', async () => {
  const result = await submitFeedbackReport(
    INPUT,
    SUBMITTER,
    config({ jira: null }),
    deps({ sync: async () => ({ status: 'pending_retry', ticketKey: null }) }),
  );
  assert.equal(result.httpStatus, 202);
  assert.deepEqual(result.body, {
    submission_id: IDEMPOTENCY_KEY,
    jira_ticket_key: null,
    status: 'pending_retry',
    screenshot_discarded: null,
  });
});

test('a submitter without a tenant still persists (tenant falls back, slug chain applies)', async () => {
  let inserted: FeedbackReportRecord | null = null;
  await submitFeedbackReport(
    INPUT,
    { ...SUBMITTER, tenantId: null, tenantSlug: null },
    config(),
    deps({
      insert: async (_pool, record) => {
        inserted = record;
        return { outcome: 'ok' };
      },
    }),
  );
  const record = inserted as unknown as FeedbackReportRecord;
  assert.equal(record.tenantId, 'unknown');
  assert.equal(record.customerSlug, 'unknown');
});

test('lost acknowledgement replay after the dedup window returns the original durable outcome', async () => {
  let stored: FeedbackReportRow | null = null;
  let insertions = 0;
  let syncCalls = 0;
  const replayDeps = deps({
    now: (() => {
      let call = 0;
      return () => new Date(call++ === 0 ? '2026-07-03T00:00:00Z' : '2026-07-03T00:02:00Z');
    })(),
    insert: async (_pool, record) => {
      if (!stored) {
        insertions += 1;
        stored = persistedRow(record);
        return { outcome: 'ok' };
      }
      return { outcome: 'replay', report: stored };
    },
    sync: async () => {
      syncCalls += 1;
      stored = { ...stored!, status: 'synced', jira_ticket_key: 'AA-42' };
      return { status: 'synced', ticketKey: 'AA-42' };
    },
  });

  const first = await submitFeedbackReport(INPUT, SUBMITTER, config(), replayDeps);
  const replay = await submitFeedbackReport(INPUT, SUBMITTER, config(), replayDeps);

  assert.equal(insertions, 1, 'a replay must not create a second durable row/Jira identity');
  assert.equal(syncCalls, 1, 'a synced replay must return stored state without a second Jira cycle');
  assert.deepEqual(replay, first);
  assert.equal(replay.body.submission_id, IDEMPOTENCY_KEY);
  assert.equal(replay.body.jira_ticket_key, 'AA-42');
});

test('replay after Jira create but before acknowledgement reconciles under the original identity', async () => {
  let syncableId: string | null = null;
  const existing = persistedRow(
    {
      id: IDEMPOTENCY_KEY,
      requestFingerprint: 'server-fingerprint',
      submitterType: SUBMITTER.attribution,
      tenantId: SUBMITTER.tenantId!,
      submitterId: SUBMITTER.userId,
      submitterEmail: SUBMITTER.email,
      submitterName: SUBMITTER.name,
      customerSlug: 'acme-co',
      category: INPUT.category,
      impact: INPUT.impact,
      title: INPUT.title,
      description: INPUT.description,
      screenshot: null,
    },
    { status: 'pending' },
  );
  const result = await submitFeedbackReport(
    INPUT,
    SUBMITTER,
    config(),
    deps({
      insert: async () => ({ outcome: 'replay', report: existing }),
      sync: async (report) => {
        syncableId = report.id;
        return { status: 'synced', ticketKey: 'AA-77' };
      },
    }),
  );

  assert.equal(syncableId, IDEMPOTENCY_KEY, 'Jira label search must reuse the original report id');
  assert.equal(result.httpStatus, 201);
  assert.equal(result.body.submission_id, IDEMPOTENCY_KEY);
  assert.equal(result.body.jira_ticket_key, 'AA-77');
});

test('idempotency key ownership/payload conflicts fail closed without disclosing the stored report', async () => {
  let syncCalls = 0;
  const result = await submitFeedbackReport(
    INPUT,
    SUBMITTER,
    config(),
    deps({
      insert: async () => ({ outcome: 'idempotency_conflict' }),
      sync: async () => {
        syncCalls += 1;
        return { status: 'synced', ticketKey: 'AA-secret' };
      },
    }),
  );

  assert.equal(result.httpStatus, 409);
  assert.equal(result.body.submission_id, null);
  assert.equal(result.body.jira_ticket_key, null);
  assert.equal(result.body.status, 'idempotency_conflict');
  assert.equal(syncCalls, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /identity|payload|AA-secret/i);
});

test('idempotency binds discarded screenshot input, not only its shared discard reason', async () => {
  let original: FeedbackReportRecord | null = null;
  const insert: NonNullable<SubmitReportDeps['insert']> = async (_pool, record) => {
    if (!original) {
      original = record;
      return { outcome: 'ok' };
    }
    return original.requestFingerprint === record.requestFingerprint
      ? { outcome: 'replay', report: persistedRow(original, { status: 'synced' }) }
      : { outcome: 'idempotency_conflict' };
  };
  const replayDeps = deps({ insert });

  await submitFeedbackReport(
    { ...INPUT, screenshot: { base64: '!!!', mime: 'image/png' } },
    SUBMITTER,
    config(),
    replayDeps,
  );
  const changed = await submitFeedbackReport(
    { ...INPUT, screenshot: { base64: '???', mime: 'image/png' } },
    SUBMITTER,
    config(),
    replayDeps,
  );

  assert.equal(changed.httpStatus, 409);
  assert.equal(changed.body.status, 'idempotency_conflict');
  assert.equal(changed.body.submission_id, null);
});

test('a scheduled or terminal replay returns stored state without bypassing retry policy', async () => {
  for (const status of ['pending_retry', 'failed'] as const) {
    let syncCalls = 0;
    const existing = persistedRow(
      {
        id: IDEMPOTENCY_KEY,
        requestFingerprint: 'server-fingerprint',
        submitterType: SUBMITTER.attribution,
        tenantId: SUBMITTER.tenantId!,
        submitterId: SUBMITTER.userId,
        submitterEmail: SUBMITTER.email,
        submitterName: SUBMITTER.name,
        customerSlug: 'acme-co',
        category: INPUT.category,
        impact: INPUT.impact,
        title: INPUT.title,
        description: INPUT.description,
        screenshot: null,
      },
      { status, jira_ticket_key: 'AA-88', attempts: 2 },
    );
    const result = await submitFeedbackReport(
      INPUT,
      SUBMITTER,
      config(),
      deps({
        insert: async () => ({ outcome: 'replay', report: existing }),
        sync: async () => {
          syncCalls += 1;
          return { status: 'synced', ticketKey: 'AA-88' };
        },
      }),
    );

    assert.equal(syncCalls, 0, `${status} must remain governed by the sweep retry policy`);
    assert.equal(result.httpStatus, 201);
    assert.equal(result.body.status, status);
    assert.equal(result.body.jira_ticket_key, 'AA-88');
  }
});
