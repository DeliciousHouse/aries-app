import assert from 'node:assert/strict';
import test from 'node:test';

import { runTick } from '../../scripts/automations/honcho-performance-worker';
import type { Queryable } from '../../backend/memory/perf-insights-read';
import type { SocialContentJobRuntimeDocument } from '../../backend/marketing/runtime-state';

// P2 — worker tick. recordPerformanceEvent / loadDoc / markWritten are injected
// mocks; selectDuePerformancePosts runs the real (gated) query against a stub
// client returning seeded rows.

const TENANT_ID = 7;

function makeDoc(jobId: string): SocialContentJobRuntimeDocument {
  return {
    job_id: jobId,
    tenant_id: String(TENANT_ID),
    inputs: { request: {}, brand_url: 'https://brand.example.com', competitor_url: 'https://comp.example.com' },
  } as unknown as SocialContentJobRuntimeDocument;
}

/**
 * Client whose first SELECT (tenant scan) returns the tenant, the second SELECT
 * (due posts) returns the seeded due rows, and any INSERT (ledger) is recorded.
 */
function makeClient(dueRows: Record<string, unknown>[]): {
  client: Queryable;
  ledgerInserts: unknown[][];
} {
  const ledgerInserts: unknown[][] = [];
  const client: Queryable = {
    async query(text: string, values?: unknown[]) {
      const t = text.trim();
      if (t.startsWith('SELECT DISTINCT tenant_id')) {
        return { rows: [{ tenant_id: TENANT_ID }] as never[] };
      }
      if (t.startsWith('INSERT INTO honcho_perf_writes')) {
        ledgerInserts.push(values ?? []);
        return { rows: [] as never[] };
      }
      // due-posts query
      return { rows: dueRows as never[] };
    },
  };
  return { client, ledgerInserts };
}

const DUE_ROW = {
  tenant_id: TENANT_ID,
  job_id: 'job-1',
  platform: 'instagram',
  publish_day: '2026-05-25',
  permalink: 'https://www.instagram.com/p/ABC/',
  caption: 'three ways to break in new leather',
  media_type: 'reel',
  views: '3400',
  reach: '1200',
  likes: '300',
  comments_count: '12',
  shares: '5',
  saves: '9',
  metric_day: '2026-06-01',
  horizon_days: '7',
  observation_day: '2026-06-01',
};

test('one tick records once with caption/media_type threaded + ledgers the horizon anchor', async () => {
  const { client, ledgerInserts } = makeClient([DUE_ROW]);
  const recorded: unknown[] = [];
  const report = await runTick(client, {
    loadDoc: async () => makeDoc('job-1'),
    record: async (input) => {
      recorded.push(input);
      return 'appended';
    },
    gateEnabled: () => true,
  });

  assert.equal(recorded.length, 1);
  const input = recorded[0] as {
    jobId: string;
    publishedAtYmd: string;
    observationDayYmd: string;
    horizonDays: number;
    payloadRecord: Record<string, unknown>;
  };
  assert.equal(input.jobId, 'job-1');
  assert.equal(input.publishedAtYmd, '20260525'); // compact for idempotency key
  assert.equal(input.observationDayYmd, '20260601');
  assert.equal(input.horizonDays, 7);
  assert.equal(input.payloadRecord.media_type, 'reel');
  assert.equal(input.payloadRecord.caption_excerpt, 'three ways to break in new leather');
  const json = JSON.stringify(input.payloadRecord);
  assert.ok(!json.includes('platform_post_id'));
  assert.ok(!json.includes('instagram_media_id'));
  assert.match(json, /https:\/\/www\.instagram\.com\/p\/ABC\//);

  assert.equal(report.written, 1);
  assert.equal(ledgerInserts.length, 1);
  // metric_day column carries the OBSERVATION ANCHOR, not the snapshot date.
  assert.deepEqual(ledgerInserts[0], [TENANT_ID, 'job-1', 'instagram', '2026-06-01']);
});

test('gate OFF: no ledger write so posts re-drive when it flips on', async () => {
  const { client, ledgerInserts } = makeClient([DUE_ROW]);
  const report = await runTick(client, {
    loadDoc: async () => makeDoc('job-1'),
    record: async () => 'skipped_gated',
    gateEnabled: () => false,
  });
  assert.equal(report.written, 0);
  assert.equal(ledgerInserts.length, 0, 'no ledger row when gate off → re-drives later');
});

test('append FAILURE is not ledgered, so the next tick retries', async () => {
  const { client, ledgerInserts } = makeClient([DUE_ROW]);
  const report = await runTick(client, {
    loadDoc: async () => makeDoc('job-1'),
    // recordPerformanceEvent releases its idempotency claim on failure; the
    // worker must correspondingly leave the ledger alone. Ledgering here would
    // silently drop the observation forever.
    record: async () => 'failed',
    gateEnabled: () => true,
  });
  assert.equal(report.written, 0);
  assert.equal(report.writeFailed, 1);
  assert.equal(ledgerInserts.length, 0);
});

test('skipped_invalid is counted, not silent', async () => {
  // A permanently malformed payload is never ledgered, so it comes back due on
  // every 30-min tick until the 30-day window closes. That is correct — but
  // without a counter the only trace is a console.warn inside write-events,
  // and the churn is invisible in the tick summary.
  const { client, ledgerInserts } = makeClient([DUE_ROW]);
  const report = await runTick(client, {
    loadDoc: async () => makeDoc('job-1'),
    record: async () => 'skipped_invalid',
    gateEnabled: () => true,
  });
  assert.equal(report.written, 0);
  assert.equal(report.writeFailed, 0, 'not a write failure — the input never got that far');
  assert.equal(report.skippedInvalid, 1);
  assert.equal(ledgerInserts.length, 0);
});

test('already-claimed idempotency key still ledgers (the write landed on an earlier tick)', async () => {
  const { client, ledgerInserts } = makeClient([DUE_ROW]);
  const report = await runTick(client, {
    loadDoc: async () => makeDoc('job-1'),
    record: async () => 'skipped_idempotent',
    gateEnabled: () => true,
  });
  assert.equal(report.written, 1);
  assert.equal(ledgerInserts.length, 1);
});

test('invalid payload outcome (skipped_invalid) is not ledgered', async () => {
  const { client, ledgerInserts } = makeClient([DUE_ROW]);
  const report = await runTick(client, {
    loadDoc: async () => makeDoc('job-1'),
    record: async () => 'skipped_invalid',
    gateEnabled: () => true,
  });
  assert.equal(report.written, 0);
  assert.equal(ledgerInserts.length, 0);
});

test('missing runtime doc skips the post, no ledger, no throw', async () => {
  const { client, ledgerInserts } = makeClient([DUE_ROW]);
  let recordCalls = 0;
  const report = await runTick(client, {
    loadDoc: async () => null,
    record: async () => {
      recordCalls += 1;
      return 'appended';
    },
    gateEnabled: () => true,
  });
  assert.equal(recordCalls, 0);
  assert.equal(report.skippedNoDoc, 1);
  assert.equal(ledgerInserts.length, 0);
});

test('per-post throw isolation: one bad post does not abort the batch', async () => {
  const rows = [
    { ...DUE_ROW, job_id: 'job-bad' },
    { ...DUE_ROW, job_id: 'job-good' },
  ];
  const { client, ledgerInserts } = makeClient(rows);
  const writtenJobs: string[] = [];
  const report = await runTick(client, {
    loadDoc: async (jobId: string) => makeDoc(jobId),
    record: async (input) => {
      if ((input as { jobId: string }).jobId === 'job-bad') {
        throw new Error('boom');
      }
      writtenJobs.push((input as { jobId: string }).jobId);
      return 'appended';
    },
    gateEnabled: () => true,
  });
  assert.deepEqual(writtenJobs, ['job-good']);
  assert.equal(report.failed, 1);
  assert.equal(report.written, 1);
  assert.equal(ledgerInserts.length, 1);
  assert.deepEqual(ledgerInserts[0], [TENANT_ID, 'job-good', 'instagram', '2026-06-01']);
});

test('null payload (no https permalink) is skipped, no ledger', async () => {
  const { client, ledgerInserts } = makeClient([{ ...DUE_ROW, permalink: null }]);
  let recordCalls = 0;
  const report = await runTick(client, {
    loadDoc: async () => makeDoc('job-1'),
    record: async () => {
      recordCalls += 1;
      return 'appended';
    },
    gateEnabled: () => true,
  });
  assert.equal(recordCalls, 0);
  assert.equal(report.skippedNoPayload, 1);
  assert.equal(ledgerInserts.length, 0);
});

test('kill switch (ARIES_INSIGHTS_513_TABLES_PRESENT=0): tick does nothing', async () => {
  process.env.ARIES_INSIGHTS_513_TABLES_PRESENT = '0';
  try {
    const { client, ledgerInserts } = makeClient([DUE_ROW]);
    let recordCalls = 0;
    const report = await runTick(client, {
      loadDoc: async () => makeDoc('job-1'),
      record: async () => {
        recordCalls += 1;
        return 'appended';
      },
      gateEnabled: () => true,
    });
    assert.equal(report.tenantsScanned, 0);
    assert.equal(recordCalls, 0);
    assert.equal(ledgerInserts.length, 0);
  } finally {
    delete process.env.ARIES_INSIGHTS_513_TABLES_PRESENT;
  }
});
