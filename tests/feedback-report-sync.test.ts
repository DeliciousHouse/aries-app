import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { JiraReportError, type JiraReportTransport } from '../backend/feedback/jira-report-client';
import type { FeedbackReportConfig } from '../backend/feedback/report-config';
import {
  buildIssueFields,
  resetPriorityFieldMemoForTests,
  syncReportToJira,
  type ReportSyncStore,
  type SyncableReport,
} from '../backend/feedback/report-sync';

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

function report(overrides: Partial<SyncableReport> = {}): SyncableReport {
  return {
    id: 'aaaa1111-2222-4333-8444-555566667777',
    submitterType: 'authenticated',
    customerSlug: 'acme',
    category: 'bug',
    impact: 'p1_account_blocked',
    title: 'It broke',
    description: 'Details',
    submitterName: 'Jo',
    submitterEmail: 'jo@acme.co',
    screenshot: null,
    jiraTicketKey: null,
    attempts: 0,
    createdAtIso: '2026-07-03T00:00:00.000Z',
    ...overrides,
  };
}

interface FakeStoreLog {
  ticketKeys: Array<{ id: string; key: string }>;
  synced: string[];
  failures: Array<{ id: string; error: string; bumpAttempts: boolean; maxAttempts: number }>;
}

function fakeStore(): { store: ReportSyncStore; log: FakeStoreLog } {
  const log: FakeStoreLog = { ticketKeys: [], synced: [], failures: [] };
  return {
    log,
    store: {
      markTicketKey: async (id, key) => {
        log.ticketKeys.push({ id, key });
      },
      markSynced: async (id) => {
        log.synced.push(id);
      },
      recordFailure: async (id, outcome) => {
        log.failures.push({ id, ...outcome });
      },
    },
  };
}

interface ClientCalls {
  searches: string[];
  creates: Array<Record<string, unknown>>;
  attaches: Array<{ key: string; filename: string }>;
}

function fakeClient(behavior: {
  search?: (label: string) => Promise<string | null>;
  create?: (fields: Record<string, unknown>) => Promise<string>;
  attach?: () => Promise<void>;
}): { client: JiraReportTransport; calls: ClientCalls } {
  const calls: ClientCalls = { searches: [], creates: [], attaches: [] };
  return {
    calls,
    client: {
      searchIssueKeyByLabel: async (label) => {
        calls.searches.push(label);
        return behavior.search ? behavior.search(label) : null;
      },
      createIssue: async (input) => {
        calls.creates.push(input.fields);
        return behavior.create ? behavior.create(input.fields) : 'AA-1';
      },
      attachScreenshot: async (key, _bytes, _mime, filename) => {
        calls.attaches.push({ key, filename });
        if (behavior.attach) await behavior.attach();
      },
    },
  };
}

beforeEach(() => {
  resetPriorityFieldMemoForTests();
});

test('happy path: search miss → create → key stored before attach → synced with bytes nulled', async () => {
  const { store, log } = fakeStore();
  const { client, calls } = fakeClient({});
  const result = await syncReportToJira(
    report({ screenshot: { bytes: Buffer.from('img'), mime: 'image/png' } }),
    config(),
    store,
    client,
  );
  assert.deepEqual(result, { status: 'synced', ticketKey: 'AA-1' });
  assert.equal(calls.searches.length, 1);
  assert.ok(calls.searches[0].startsWith('aries-sub-'));
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.attaches.length, 1);
  assert.deepEqual(log.ticketKeys, [{ id: report().id, key: 'AA-1' }]);
  assert.deepEqual(log.synced, [report().id]);
  assert.equal(log.failures.length, 0);
});

test('unconfigured Jira parks the row WITHOUT burning an attempt', async () => {
  const { store, log } = fakeStore();
  const result = await syncReportToJira(report(), config({ jira: null }), store);
  assert.deepEqual(result, { status: 'pending_retry', ticketKey: null });
  assert.equal(log.failures.length, 1);
  assert.equal(log.failures[0].bumpAttempts, false);
  assert.equal(log.failures[0].error, 'jira_not_configured');
});

test('idempotency: a stored ticket key skips search AND create (attach-only completion)', async () => {
  const { store, log } = fakeStore();
  const { client, calls } = fakeClient({});
  const result = await syncReportToJira(
    report({
      jiraTicketKey: 'AA-9',
      screenshot: { bytes: Buffer.from('img'), mime: 'image/jpeg' },
    }),
    config(),
    store,
    client,
  );
  assert.deepEqual(result, { status: 'synced', ticketKey: 'AA-9' });
  assert.equal(calls.searches.length, 0);
  assert.equal(calls.creates.length, 0);
  assert.deepEqual(calls.attaches, [{ key: 'AA-9', filename: `screenshot-${report().id}.jpg` }]);
  assert.deepEqual(log.synced, [report().id]);
});

test('idempotency: a label-search hit adopts the key and never creates', async () => {
  const { store, log } = fakeStore();
  const { client, calls } = fakeClient({ search: async () => 'AA-77' });
  const result = await syncReportToJira(report(), config(), store, client);
  assert.deepEqual(result, { status: 'synced', ticketKey: 'AA-77' });
  assert.equal(calls.creates.length, 0, 'create must not run on a search hit');
  assert.deepEqual(log.ticketKeys, [{ id: report().id, key: 'AA-77' }]);
});

test('search failure: row stays retryable and create is NEVER called', async () => {
  const { store, log } = fakeStore();
  const { client, calls } = fakeClient({
    search: async () => {
      throw new JiraReportError('jira search failed (HTTP 503)', 503);
    },
  });
  const result = await syncReportToJira(report(), config(), store, client);
  assert.deepEqual(result, { status: 'pending_retry', ticketKey: null });
  assert.equal(calls.creates.length, 0);
  assert.equal(log.failures.length, 1);
  assert.equal(log.failures[0].bumpAttempts, true);
});

test('create failure parks the row with a completed attempt', async () => {
  const { store, log } = fakeStore();
  const { client } = fakeClient({
    create: async () => {
      throw new JiraReportError('jira create failed (HTTP 502)', 502);
    },
  });
  const result = await syncReportToJira(report(), config(), store, client);
  assert.deepEqual(result, { status: 'pending_retry', ticketKey: null });
  assert.equal(log.failures[0].bumpAttempts, true);
});

test('a failure landing exactly at max attempts reports terminal failed', async () => {
  const { store } = fakeStore();
  const { client } = fakeClient({
    create: async () => {
      throw new JiraReportError('boom', 500);
    },
  });
  const result = await syncReportToJira(
    report({ attempts: 4 }), // 5th completed failure with max=5
    config({ retryMaxAttempts: 5 }),
    store,
    client,
  );
  assert.equal(result.status, 'failed');
});

test('attach failure after create: key stored, 201-eligible result, row retryable', async () => {
  const { store, log } = fakeStore();
  const { client } = fakeClient({
    attach: async () => {
      throw new JiraReportError('jira attach failed (HTTP 500)', 500);
    },
  });
  const result = await syncReportToJira(
    report({ screenshot: { bytes: Buffer.from('img'), mime: 'image/png' } }),
    config(),
    store,
    client,
  );
  assert.deepEqual(result, { status: 'pending_retry', ticketKey: 'AA-1' });
  assert.deepEqual(log.ticketKeys, [{ id: report().id, key: 'AA-1' }]);
  assert.equal(log.synced.length, 0, 'bytes must be kept for the sweep to re-attach');
  assert.equal(log.failures[0].bumpAttempts, true);
});

test('priority-field rejection retries once without priority and memoizes', async () => {
  const { store } = fakeStore();
  let call = 0;
  const { client, calls } = fakeClient({
    create: async (fields) => {
      call += 1;
      if (call === 1) {
        assert.ok(fields.priority, 'first attempt carries the mapped priority');
        throw new JiraReportError(
          "jira create failed (HTTP 400): priority: Field 'priority' cannot be set",
          400,
        );
      }
      assert.equal(fields.priority, undefined, 'retry must drop the priority field');
      return 'AA-2';
    },
  });
  const result = await syncReportToJira(report(), config(), store, client);
  assert.deepEqual(result, { status: 'synced', ticketKey: 'AA-2' });
  assert.equal(calls.creates.length, 2);

  // Memoized: the next create in this process skips priority entirely.
  const second = fakeClient({
    create: async (fields) => {
      assert.equal(fields.priority, undefined);
      return 'AA-3';
    },
  });
  const again = await syncReportToJira(
    report({ id: 'bbbb1111-2222-4333-8444-555566667777' }),
    config(),
    fakeStore().store,
    second.client,
  );
  assert.equal(again.ticketKey, 'AA-3');
  assert.equal(second.calls.creates.length, 1);
});

test('a non-priority 400 does NOT trigger the degrade retry', async () => {
  const { store } = fakeStore();
  const { client, calls } = fakeClient({
    create: async () => {
      throw new JiraReportError('jira create failed (HTTP 400): summary: required', 400);
    },
  });
  const result = await syncReportToJira(report(), config(), store, client);
  assert.equal(result.status, 'pending_retry');
  assert.equal(calls.creates.length, 1);
});

test('issue fields carry Bug type, mapped priority, labels, and ADF description', () => {
  const jira = config().jira!;
  const fields = buildIssueFields(jira, report(), true);
  assert.deepEqual(fields.project, { key: 'AA' });
  assert.deepEqual(fields.issuetype, { name: 'Bug' });
  assert.deepEqual(fields.priority, { name: 'P1 - Critical' });
  assert.equal(fields.summary, 'It broke');
  assert.deepEqual(fields.labels, [
    'customer-incident',
    'customer-acme',
    `aries-sub-${report().id}`,
    'impact-p1',
  ]);
  const description = fields.description as { type: string };
  assert.equal(description.type, 'doc');
  const without = buildIssueFields(jira, report(), false);
  assert.equal(without.priority, undefined);
});

test('anonymous Jira issues are explicitly labeled and contain no fake contact attribution', () => {
  const fields = buildIssueFields(
    config().jira!,
    report({
      submitterType: 'anonymous',
      customerSlug: 'anonymous',
      submitterName: null,
      submitterEmail: null,
    }),
    true,
  );

  assert.ok((fields.labels as string[]).includes('anonymous-feedback'));
  const serialized = JSON.stringify(fields.description);
  assert.ok(serialized.includes('Submitter: Anonymous'));
  assert.ok(!serialized.includes('Name: unknown'));
  assert.ok(!serialized.includes('Email: unknown'));
});
