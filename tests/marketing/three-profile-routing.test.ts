import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HermesMarketingPort } from '../../backend/marketing/ports/hermes';
import type { MarketingJobRuntimeDocument } from '../../backend/marketing/runtime-state';

/**
 * Phase B three-profile routing. Each marketing stage must POST to its
 * dedicated Hermes profile gateway, and an unconfigured deployment must still
 * route every stage to HERMES_GATEWAY_URL (no behavior change).
 */

type FetchCall = { url: string; init: RequestInit };

function recordingFetch() {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ run_id: 'hermes-run-1', status: 'started' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const NO_SLEEP = async () => {};
const NO_OP_BRAND_KIT_REFRESHER = async () => ({ refreshed: false, enriched: false });

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-three-profile-routing-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const STUB_DOC = {
  job_id: 'job_test',
  tenant_id: 'tenant_test',
  created_by: 'user_test',
  inputs: {
    brand_url: 'https://brand.example',
    request: { jobType: 'weekly_social_content', imageCreativeCount: 7 },
  },
  brand_kit: { brand_name: 'Brand Co' },
} as unknown as MarketingJobRuntimeDocument;

const PER_PROFILE_ENV = {
  HERMES_GATEWAY_URL: 'http://127.0.0.1:8642',
  HERMES_API_SERVER_KEY: 'default-key',
  HERMES_RESEARCH_GATEWAY_URL: 'http://host.docker.internal:8642',
  HERMES_RESEARCH_API_SERVER_KEY: 'research-key',
  HERMES_STRATEGIST_GATEWAY_URL: 'http://host.docker.internal:8654',
  HERMES_STRATEGIST_API_SERVER_KEY: 'strategist-key',
  HERMES_CONTENT_GATEWAY_URL: 'http://host.docker.internal:8655',
  HERMES_CONTENT_API_SERVER_KEY: 'content-key',
  INTERNAL_API_SECRET: 'internal-secret',
  APP_BASE_URL: 'https://aries.example.com',
  HERMES_POLL_BRIDGE_ENABLED: '0',
};

const SINGLE_GATEWAY_ENV = {
  HERMES_GATEWAY_URL: 'http://127.0.0.1:8642',
  HERMES_API_SERVER_KEY: 'default-key',
  INTERNAL_API_SECRET: 'internal-secret',
  APP_BASE_URL: 'https://aries.example.com',
  HERMES_POLL_BRIDGE_ENABLED: '0',
};

function makePort(env: Record<string, string>, fetchImpl: typeof fetch) {
  return new HermesMarketingPort(
    env,
    fetchImpl as unknown as (input: string | URL, init?: RequestInit) => Promise<Response>,
    NO_SLEEP,
    NO_OP_BRAND_KIT_REFRESHER,
  );
}

function resumeInput(stage: 'strategy' | 'production' | 'publish') {
  return {
    resumeToken: 'resume-token-1',
    approve: true,
    tenantId: 'tenant_test',
    jobId: 'job_test',
    approvalId: 'approval_1',
    stage,
    workflowStepId: 'approve_stage_x',
    approvalStep: null,
    workflowKey: 'marketing_pipeline',
  };
}

test('research stage routes to the aries-research gateway', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    await port.runPipeline({ jobId: 'job_test', doc: STUB_DOC, argsJson: '{}' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://host.docker.internal:8642/v1/runs');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer research-key');
  });
});

test('strategy stage routes to the aries-strategist gateway', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    await port.resumePipeline(resumeInput('strategy'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://host.docker.internal:8654/v1/runs');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer strategist-key');
  });
});

test('production stage routes to the aries-content-generator gateway', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    await port.resumePipeline(resumeInput('production'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://host.docker.internal:8655/v1/runs');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer content-key');
  });
});

test('publish stage routes to the aries-strategist gateway (reasoning, no tools)', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    await port.resumePipeline(resumeInput('publish'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://host.docker.internal:8654/v1/runs');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer strategist-key');
  });
});

test('no behavior change: every stage falls back to HERMES_GATEWAY_URL when per-profile vars are unset', async () => {
  await withDataRoot(async () => {
    for (const run of [
      async (port: HermesMarketingPort) =>
        port.runPipeline({ jobId: 'job_test', doc: STUB_DOC, argsJson: '{}' }),
      async (port: HermesMarketingPort) => port.resumePipeline(resumeInput('strategy')),
      async (port: HermesMarketingPort) => port.resumePipeline(resumeInput('production')),
      async (port: HermesMarketingPort) => port.resumePipeline(resumeInput('publish')),
    ]) {
      const { calls, fetchImpl } = recordingFetch();
      const port = makePort(SINGLE_GATEWAY_ENV, fetchImpl as unknown as typeof fetch);
      await run(port);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://127.0.0.1:8642/v1/runs');
      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers.authorization, 'Bearer default-key');
    }
  });
});
