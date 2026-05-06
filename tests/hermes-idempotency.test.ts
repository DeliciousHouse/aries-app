import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HermesMarketingPort } from '../backend/marketing/ports/hermes';
import type { MarketingJobRuntimeDocument } from '../backend/marketing/runtime-state';
import { TEST_HERMES_GATEWAY_URL } from './fixtures/service-urls';

type FetchCall = { url: string; init: RequestInit };

function recordingFetchSequence(responses: Array<() => Response>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const make = responses[i] ?? responses[responses.length - 1];
    if (i < responses.length - 1) i += 1;
    return make();
  };
  return { calls, fetchImpl };
}

const NO_SLEEP = async () => {};
const NO_OP_BRAND_KIT_REFRESHER = async () => ({ refreshed: false });

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-hermes-idempotency-'));

  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const STUB_DOC = {
  job_id: 'job_test',
  tenant_id: 'tenant_test',
  created_by: 'user_test',
  inputs: {
    brand_url: 'https://brand.example',
    competitor_url: 'https://competitor.example',
    competitor_brand: 'Competitor',
    facebook_page_url: 'https://facebook.com/competitor',
    ad_library_url: 'https://facebook.com/ads/library',
    request: {
      jobType: 'weekly_social_content',
      imageCreativeCount: 9,
      videoRenderCount: 7,
      openaiConnectionId: 'conn_openai_test',
      openaiAccessToken: 'sk-live-should-not-appear',
    },
  },
  brand_kit: {
    brand_name: 'Brand Co',
  },
} as unknown as MarketingJobRuntimeDocument;

const STUB_RUN_INPUT = {
  jobId: 'job_test',
  doc: STUB_DOC,
  argsJson: '{"job_id":"job_test"}',
  timeoutMs: 1_000,
  maxStdoutBytes: 65_536,
};

test('HermesMarketingPort generates deterministic idempotency_key from aries_run_id + workflow_version + tenant_id', async () => {
  await withDataRoot(async () => {
    const { calls: calls1, fetchImpl: fetchImpl1 } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-run-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);

    const port1 = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: `${TEST_HERMES_GATEWAY_URL}/`,
        HERMES_API_SERVER_KEY: 'token-123',
        INTERNAL_API_SECRET: 'internal-secret',
        APP_BASE_URL: 'https://aries.example.com',
        HERMES_SESSION_KEY: 'marketing-session',
      },
      fetchImpl1,
      NO_SLEEP,
      NO_OP_BRAND_KIT_REFRESHER,
    );

    const result1 = await port1.runPipeline(STUB_RUN_INPUT);
    assert.equal(result1.kind, 'submitted');

    const body1 = JSON.parse(String(calls1[0].init.body));
    const idempotencyKey1 = body1.idempotency_key;
    const ariesRunId1 = body1.aries_run_id;
    const workflowVersion1 = body1.workflow_version;

    assert.match(String(idempotencyKey1), /^[0-9a-f]{64}$/);

    const crypto = await import('node:crypto');
    const expectedKey = crypto.createHash('sha256')
      .update(`${ariesRunId1}|${workflowVersion1}|tenant_test`)
      .digest('hex');
    assert.equal(idempotencyKey1, expectedKey, 'idempotency_key should match deterministic hash');
  });
});

test('HermesMarketingPort includes Idempotency-Key HTTP header in submission', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-run-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);

    const port = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: `${TEST_HERMES_GATEWAY_URL}/`,
        HERMES_API_SERVER_KEY: 'token-123',
        INTERNAL_API_SECRET: 'internal-secret',
        APP_BASE_URL: 'https://aries.example.com',
        HERMES_SESSION_KEY: 'marketing-session',
      },
      fetchImpl,
      NO_SLEEP,
      NO_OP_BRAND_KIT_REFRESHER,
    );

    const result = await port.runPipeline(STUB_RUN_INPUT);
    assert.equal(result.kind, 'submitted');

    assert.equal(calls.length, 1);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.ok(headers['idempotency-key'], 'Idempotency-Key header should be present');
    assert.match(String(headers['idempotency-key']), /^[0-9a-f]{64}$/);

    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(headers['idempotency-key'], body.idempotency_key);
  });
});

test('HermesMarketingPort idempotency_key changes when aries_run_id changes', async () => {
  await withDataRoot(async () => {
    const { calls: calls1, fetchImpl: fetchImpl1 } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-run-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);

    const port1 = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: `${TEST_HERMES_GATEWAY_URL}/`,
        HERMES_API_SERVER_KEY: 'token-123',
        INTERNAL_API_SECRET: 'internal-secret',
        APP_BASE_URL: 'https://aries.example.com',
        HERMES_SESSION_KEY: 'marketing-session',
      },
      fetchImpl1,
      NO_SLEEP,
      NO_OP_BRAND_KIT_REFRESHER,
    );

    const result1 = await port1.runPipeline(STUB_RUN_INPUT);
    const body1 = JSON.parse(String(calls1[0].init.body));
    const idempotencyKey1 = body1.idempotency_key;

    const { calls: calls2, fetchImpl: fetchImpl2 } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-run-2', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);

    const port2 = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: `${TEST_HERMES_GATEWAY_URL}/`,
        HERMES_API_SERVER_KEY: 'token-123',
        INTERNAL_API_SECRET: 'internal-secret',
        APP_BASE_URL: 'https://aries.example.com',
        HERMES_SESSION_KEY: 'marketing-session',
      },
      fetchImpl2,
      NO_SLEEP,
      NO_OP_BRAND_KIT_REFRESHER,
    );

    const result2 = await port2.runPipeline(STUB_RUN_INPUT);
    const body2 = JSON.parse(String(calls2[0].init.body));
    const idempotencyKey2 = body2.idempotency_key;

    assert.notEqual(idempotencyKey2, idempotencyKey1, 'different aries_run_id should produce different key');
  });
});
