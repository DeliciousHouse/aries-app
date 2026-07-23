import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import type { Pool, PoolClient } from 'pg';

import type { FeedbackReportConfig } from '../backend/feedback/report-config';
import type { FeedbackReportRow } from '../backend/feedback/report-store';
import {
  resetRetrySweepLogMemoForTests,
  runFeedbackRetrySweep,
  type RetrySweepDeps,
} from '../backend/feedback/retry-sweep';
import type { ReportSyncStore } from '../backend/feedback/report-sync';

const FAKE_POOL = {} as unknown as Pool;

const NOOP_STORE: ReportSyncStore = {
  markCreateInFlight: async () => {},
  markCreateUncertain: async () => {},
  recordCreateReconcileMiss: async () => {},
  markTicketKey: async () => {},
  markSynced: async () => {},
  recordFailure: async () => {},
};

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
    sharedRateLimitPerHour: 100,
    dedupWindowSeconds: 60,
    retryIntervalMinutes: 5,
    retryBatchLimit: 10,
    retryMaxAttempts: 5,
    stalePendingMinutes: 15,
    ...overrides,
  };
}

function row(id: string, overrides: Partial<FeedbackReportRow> = {}): FeedbackReportRow {
  return {
    id,
    request_fingerprint: `fingerprint-${id}`,
    submitter_type: 'authenticated',
    tenant_id: '15',
    submitter_id: 'user-1',
    submitter_email: 'jo@acme.co',
    submitter_name: 'Jo',
    customer_slug: 'acme',
    category: 'bug',
    impact: 'p2_feature_degraded',
    title: 't',
    description: 'd',
    screenshot_bytes: null,
    screenshot_mime: null,
    jira_ticket_key: null,
    jira_create_state: 'not_started',
    jira_create_token: null,
    attachment_state: 'none',
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: new Date('2026-07-03T00:00:00.000Z'),
    updated_at: new Date('2026-07-03T00:00:00.000Z'),
    ...overrides,
  };
}

function lockAndReload(
  rows: FeedbackReportRow[],
): Pick<RetrySweepDeps, 'withSyncLock' | 'getById'> {
  return {
    withSyncLock: async <T,>(
      _pool: Pool,
      _id: string,
      work: (client: PoolClient) => Promise<T>,
    ) => work({} as PoolClient),
    getById: async (_client: Pool | PoolClient, id: string) =>
      rows.find((item) => item.id === id) ?? null,
  };
}

beforeEach(() => {
  resetRetrySweepLogMemoForTests();
});

test('unconfigured Jira: no-op, one info line per process, no claims', async () => {
  const logs: string[] = [];
  let claims = 0;
  const cfg = config({ jira: null });
  const deps = {
    log: (message: string) => logs.push(message),
    claim: async () => {
      claims += 1;
      return [];
    },
  };
  const first = await runFeedbackRetrySweep(FAKE_POOL, cfg, deps);
  const second = await runFeedbackRetrySweep(FAKE_POOL, cfg, deps);
  assert.equal(first.configured, false);
  assert.equal(second.configured, false);
  assert.equal(claims, 0, 'unconfigured sweep must not touch the DB claim');
  assert.equal(logs.length, 1, 'exactly one notice per process, never error-spin');
});

test('empty claim is a clean no-op', async () => {
  const report = await runFeedbackRetrySweep(FAKE_POOL, config(), {
    ensureTable: async () => {},
    claim: async () => [],
    sync: async () => {
      throw new Error('must not be called');
    },
    store: NOOP_STORE,
  });
  assert.deepEqual(report, {
    configured: true,
    claimed: 0,
    synced: 0,
    retried: 0,
    failed: 0,
    errors: 0,
  });
});

test('claimed rows fan through sync with per-row outcome counts', async () => {
  const seen: string[] = [];
  const claimed = [row('a'), row('b'), row('c')];
  const report = await runFeedbackRetrySweep(FAKE_POOL, config(), {
    ensureTable: async () => {},
    claim: async () => claimed,
    ...lockAndReload(claimed),
    sync: async (syncable) => {
      seen.push(syncable.id);
      if (syncable.id === 'a') return { status: 'synced' as const, ticketKey: 'AA-1' };
      if (syncable.id === 'b') return { status: 'pending_retry' as const, ticketKey: null };
      return { status: 'failed' as const, ticketKey: null };
    },
    store: NOOP_STORE,
  });
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(report.claimed, 3);
  assert.equal(report.synced, 1);
  assert.equal(report.retried, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.errors, 0);
});

test('every claimed row enters the shared report lock and reloads before Jira work', async () => {
  let lockCalls = 0;
  let reloadCalls = 0;
  const claimed = row('locked-report', { attempts: 1 });
  const reloaded = row('locked-report', { attempts: 4 });

  const deps: RetrySweepDeps = {
    ensureTable: async () => {},
    claim: async () => [claimed],
    withSyncLock: async (_pool, id, work) => {
      lockCalls += 1;
      assert.equal(id, claimed.id);
      return work({} as never);
    },
    getById: async (_client, id) => {
      reloadCalls += 1;
      assert.equal(lockCalls, 1, 'reload must happen while the shared lock is held');
      assert.equal(id, claimed.id);
      return reloaded;
    },
    sync: async (syncable) => {
      assert.equal(syncable.attempts, 4);
      return { status: 'synced', ticketKey: 'AA-1' };
    },
    store: NOOP_STORE,
  };
  const report = await runFeedbackRetrySweep(FAKE_POOL, config(), deps);

  assert.equal(lockCalls, 1);
  assert.equal(reloadCalls, 1);
  assert.equal(report.synced, 1);
});

test('one row throwing never kills the loop — the rest still process', async () => {
  const processed: string[] = [];
  const claimed = [row('a'), row('boom'), row('c')];
  const report = await runFeedbackRetrySweep(FAKE_POOL, config(), {
    ensureTable: async () => {},
    claim: async () => claimed,
    ...lockAndReload(claimed),
    sync: async (syncable) => {
      if (syncable.id === 'boom') throw new Error('store write failed');
      processed.push(syncable.id);
      return { status: 'synced' as const, ticketKey: 'AA-1' };
    },
    store: NOOP_STORE,
  });
  assert.deepEqual(processed, ['a', 'c']);
  assert.equal(report.errors, 1);
  assert.equal(report.synced, 2);
});

test('a claim-level failure is caught (cycle survives, reported as an error)', async () => {
  const report = await runFeedbackRetrySweep(FAKE_POOL, config(), {
    ensureTable: async () => {},
    claim: async () => {
      throw new Error('db unreachable');
    },
    store: NOOP_STORE,
  });
  assert.equal(report.errors, 1);
  assert.equal(report.claimed, 0);
});

test('rows keep their loaded attempts/ticket key through rowToSyncable (reconcile-only path)', async () => {
  let sawKey: string | null = null;
  let sawAttempts = -1;
  const claimed = [
    row('with-key', {
      jira_ticket_key: 'AA-9',
      attempts: 3,
      screenshot_bytes: Buffer.from('img'),
      screenshot_mime: 'image/png',
    }),
  ];
  await runFeedbackRetrySweep(FAKE_POOL, config(), {
    ensureTable: async () => {},
    claim: async () => claimed,
    ...lockAndReload(claimed),
    sync: async (syncable) => {
      sawKey = syncable.jiraTicketKey;
      sawAttempts = syncable.attempts;
      return { status: 'synced' as const, ticketKey: 'AA-9' };
    },
    store: NOOP_STORE,
  });
  assert.equal(sawKey, 'AA-9');
  assert.equal(sawAttempts, 3);
});
