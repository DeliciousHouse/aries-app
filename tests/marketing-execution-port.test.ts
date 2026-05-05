import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MARKETING_EXECUTION_PORT,
  getMarketingExecutionPort,
  resolveMarketingExecutionPortName,
} from '../backend/marketing/execution-port';
import { HermesMarketingPort } from '../backend/marketing/ports/hermes';
import type { MarketingJobRuntimeDocument } from '../backend/marketing/runtime-state';
import { TEST_HERMES_GATEWAY_URL } from './fixtures/service-urls';

const STUB_RUNTIME_PATHS = { gatewayCwd: 'lobster', localCwd: '/tmp/lobster' };

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

const BRAND_CAMPAIGN_DOC = {
  job_id: 'job_brand',
  tenant_id: 'tenant_brand',
  inputs: {
    brand_url: 'https://brand.example',
    competitor_url: 'https://competitor.example',
    request: {
      jobType: 'brand_campaign',
    },
  },
} as unknown as MarketingJobRuntimeDocument;

const BRAND_CAMPAIGN_RUN_INPUT = {
  jobId: 'job_brand',
  doc: BRAND_CAMPAIGN_DOC,
  argsJson: '{"job_id":"job_brand"}',
  timeoutMs: 1_000,
  maxStdoutBytes: 65_536,
};

const STUB_RESUME_INPUT = {
  resumeToken: 'opaque-token-123',
  approve: true,
  timeoutMs: 1_000,
  maxStdoutBytes: 65_536,
};

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

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-port-'));

  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('marketing port name defaults to hermes when no env var is set', () => {
  assert.equal(resolveMarketingExecutionPortName({}), 'hermes');
  assert.equal(DEFAULT_MARKETING_EXECUTION_PORT, 'hermes');
});

test('marketing port name selects hermes only when ARIES_MARKETING_EXECUTION_PROVIDER=hermes', () => {
  assert.equal(
    resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes' }),
    'hermes',
  );
  assert.equal(
    resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: ' Hermes ' }),
    'hermes',
  );
});

test('marketing port name maps explicit legacy-openclaw selection to hermes', () => {
  assert.equal(
    resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'legacy-openclaw' }),
    'hermes',
  );
});

test('marketing port name falls back to hermes on unknown values', () => {
  assert.equal(
    resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'unsupported' }),
    'hermes',
  );
});

test('getMarketingExecutionPort returns the Hermes port by default', () => {
  const port = getMarketingExecutionPort(() => STUB_RUNTIME_PATHS, {});
  assert.ok(port instanceof HermesMarketingPort);
  assert.equal(port.name, 'hermes');
});

test('getMarketingExecutionPort returns the Hermes port when explicitly selected', () => {
  const port = getMarketingExecutionPort(
    () => STUB_RUNTIME_PATHS,
    { ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes' },
  );
  assert.ok(port instanceof HermesMarketingPort);
  assert.equal(port.name, 'hermes');
});

test('HermesMarketingPort.runPipeline returns submitted immediately by default', async () => {
  await withDataRoot(async () => {
    const { loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { calls, fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-marketing-run-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const NO_SLEEP = async () => {};
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
    );
    const result = await port.runPipeline(STUB_RUN_INPUT);

    assert.equal(result.kind, 'submitted');
    assert.equal(result.provider, 'hermes');
    assert.equal(result.hermesRunId, 'hermes-marketing-run-1');
    assert.equal(calls.length, 1);

    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.callback_url, 'https://aries.example.com/api/internal/hermes/runs');
    assert.deepEqual(body.callback_auth, {
      type: 'internal_api_secret_bearer',
      secret_ref: 'INTERNAL_API_SECRET',
    });
    assert.deepEqual(body.callback_context, {
      workflow_key: 'social_content_weekly',
      workflow_version: '2026-05-social-content-weekly-v1',
      aries_run_id: result.ariesRunId,
      job_id: 'job_test',
      tenant_id: 'tenant_test',
    });
    assert.equal(body.session_id, 'marketing-session');
    assert.equal(body.workflow_key, 'social_content_weekly');
    assert.equal(body.workflow_version, '2026-05-social-content-weekly-v1');
    assert.equal(body.aries_run_id, result.ariesRunId);
    assert.equal(body.tenant_id, 'tenant_test');
    assert.equal(body.job_id, 'job_test');
    assert.equal(body.callback_url, 'https://aries.example.com/api/internal/hermes/runs');
    assert.equal(body.input.scope.window_days, 7);
    assert.equal(body.input.scope.static_post_count, 3);
    assert.equal(body.input.scope.image_creative_count, 2);
    assert.equal(body.input.scope.video_script_count, 1);
    assert.equal(body.input.scope.video_render_count, 1);
    assert.deepEqual(body.input.scope.channels, ['meta', 'instagram']);
    assert.equal('media_provider' in body, false);
    assert.equal(Array.isArray(body.input.media_requests), true);
    assert.deepEqual(body.input.media_requests, [
      {
        type: 'image.generate',
        aspect_ratio: '4:5',
        count: 2,
        target_channels: ['meta', 'instagram'],
        creative_briefs: ['Create on-brand weekly social image creative.'],
      },
      {
        type: 'video.generate',
        aspect_ratio: '9:16',
        count: 1,
        requires_human_approval: true,
        script_id: 'weekly_primary',
      },
    ]);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('conn_openai_test'), false);
    assert.equal(serialized.includes('.lobster'), false);
    assert.equal(serialized.includes('marketing_pipeline'), false);
    assert.equal(serialized.toLowerCase().includes('openclaw'), false);
    assert.equal(serialized.includes('sk-live-should-not-appear'), false);
    assert.equal(/gemini|nano banana/i.test(serialized), false);

    const ariesRunId = String(body.aries_run_id);
    const stored = loadExecutionRunRecord(ariesRunId);
    assert.equal(stored?.domain, 'marketing');
    assert.equal(stored?.workflow_key, 'social_content_weekly');
    assert.equal(stored?.marketing_job_id, 'job_test');
    assert.equal(stored?.stage, 'research');
    assert.equal(stored?.external_run_id, 'hermes-marketing-run-1');
  });
});

test('HermesMarketingPort preserves brand campaign workflow key for non-weekly runs', async () => {
  await withDataRoot(async () => {
    const { loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { calls, fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-brand-run-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const port = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
        HERMES_API_SERVER_KEY: 'token-123',
        INTERNAL_API_SECRET: 'internal-secret',
        APP_BASE_URL: 'https://aries.example.com',
      },
      fetchImpl,
    );

    const result = await port.runPipeline(BRAND_CAMPAIGN_RUN_INPUT);

    assert.equal(result.kind, 'submitted');
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.workflow_key, undefined);
    assert.equal(body.workflow_version, undefined);
    assert.equal(body.callback_context.workflow_key, 'marketing_pipeline');
    assert.equal(body.callback_context.workflow_version, undefined);
    assert.match(body.input, /Workflow: marketing_pipeline/);
    assert.doesNotMatch(body.input, /Workflow: social_content_weekly/);
    assert.match(body.input, /"job_id":"job_brand"/);

    const ariesRunIdMatch = String(body.input).match(/Aries run ID: (arun_[^\n]+)/);
    const stored = loadExecutionRunRecord(ariesRunIdMatch?.[1] ?? '');
    assert.equal(stored?.workflow_key, 'marketing_pipeline');
    assert.equal(stored?.marketing_job_id, 'job_brand');
  });
});

test('HermesMarketingPort polls only when HERMES_SYNC_POLL_FOR_TESTS=1', async () => {
  await withDataRoot(async () => {
    const completedOutput = JSON.stringify({ ok: true, status: 'completed', output: [] });
    const { calls, fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-resume-run-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
      () => new Response(JSON.stringify({ run_id: 'hermes-resume-run-1', status: 'completed', output: completedOutput }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const NO_SLEEP = async () => {};
    const port = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
        HERMES_API_SERVER_KEY: 'token-123',
        INTERNAL_API_SECRET: 'internal-secret',
        APP_BASE_URL: 'https://aries.example.com',
        HERMES_SYNC_POLL_FOR_TESTS: '1',
        HERMES_RUN_TIMEOUT_MS: '30000',
        HERMES_POLL_INTERVAL_MS: '0',
      },
      fetchImpl,
      NO_SLEEP,
    );

    const result = await port.resumePipeline(STUB_RESUME_INPUT);

    assert.equal(result.kind, 'completed');
    assert.equal(result.provider, 'hermes');
    assert.equal(result.output.ok, true);
    assert.equal(result.output.status, 'completed');
    assert.equal(calls.length, 2);
    const body = JSON.parse(String(calls[0].init.body));
    assert.match(body.input, /Action: resume/);
    assert.match(body.input, /Approve: true/);
    assert.match(body.input, /Resume token: opaque-token-123/);
    assert.equal(calls[1].url, `${TEST_HERMES_GATEWAY_URL}/v1/runs/hermes-resume-run-1`);
  });
});

test('HermesMarketingPort social-content resume includes callback correlation metadata', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-social-resume-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const port = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
        HERMES_API_SERVER_KEY: 'token-123',
        INTERNAL_API_SECRET: 'raw-internal-secret-must-not-leak',
        APP_BASE_URL: 'https://aries.example.com',
      },
      fetchImpl,
    );

    const result = await port.resumePipeline({
      ...STUB_RESUME_INPUT,
      tenantId: 'tenant_test',
      jobId: 'job_test',
      approvalId: 'mkta_test',
      workflowStepId: 'approve_weekly_plan',
      approvalStep: 'approve_weekly_plan',
      workflowKey: 'social_content_weekly',
    });

    assert.equal(result.kind, 'submitted');
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.workflow_key, 'social_content_weekly');
    assert.equal(body.action, 'resume');
    assert.equal(body.aries_run_id, result.ariesRunId);
    assert.equal(body.callback_url, 'https://aries.example.com/api/internal/hermes/runs');
    assert.deepEqual(body.callback_auth, {
      type: 'internal_api_secret_bearer',
      secret_ref: 'INTERNAL_API_SECRET',
    });
    assert.deepEqual(body.callback_context, {
      workflow_key: 'social_content_weekly',
      aries_run_id: result.ariesRunId,
      job_id: 'job_test',
      tenant_id: 'tenant_test',
      approval_id: 'mkta_test',
      approval_step: 'approve_weekly_plan',
    });
    assert.equal(JSON.stringify(body).includes('raw-internal-secret-must-not-leak'), false);
  });
});

test('HermesMarketingPort sync polling preserves documented approval payloads', async () => {
  await withDataRoot(async () => {
    const approvalOutput = JSON.stringify({
      ok: true,
      status: 'requires_approval',
      workflowKey: 'marketing_pipeline',
      approval: {
        stage: 'production',
        workflow_step_id: 'approve_stage_3',
        prompt: 'Approve production assets?',
        resume_token: 'resume-production-123',
      },
      output: [],
    });
    const { calls, fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ run_id: 'hermes-approval-run-1', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
      () => new Response(JSON.stringify({ run_id: 'hermes-approval-run-1', status: 'completed', output: approvalOutput }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const port = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
        HERMES_API_SERVER_KEY: 'token-123',
        INTERNAL_API_SECRET: 'internal-secret',
        APP_BASE_URL: 'https://aries.example.com',
        HERMES_SYNC_POLL_FOR_TESTS: '1',
        HERMES_RUN_TIMEOUT_MS: '30000',
        HERMES_POLL_INTERVAL_MS: '0',
      },
      fetchImpl,
      async () => {},
    );

    const result = await port.resumePipeline(STUB_RESUME_INPUT);

    assert.equal(result.kind, 'completed');
    assert.equal(result.output.status, 'requires_approval');
    assert.deepEqual(result.output.approval, {
      stage: 'production',
      workflowStepId: 'approve_stage_3',
      prompt: 'Approve production assets?',
      resumeToken: 'resume-production-123',
    });
    assert.equal(calls.length, 2);
  });
});

test('HermesMarketingPort reports missing config as a completed error result', async () => {
  const port = new HermesMarketingPort({ HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL }); // missing HERMES_API_SERVER_KEY
  const result = await port.runPipeline(STUB_RUN_INPUT);

  assert.equal(result.kind, 'completed');
  assert.equal(result.provider, 'hermes');
  assert.equal(result.output.ok, false);
  assert.equal(result.output.status, 'failed');
  assert.equal(result.output.error?.code, 'hermes_gateway_not_configured');
});

test('HermesMarketingPort requires INTERNAL_API_SECRET for social-content execution', async () => {
  const port = new HermesMarketingPort({
    HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
    HERMES_API_SERVER_KEY: 'token-123',
    APP_BASE_URL: 'https://aries.example.com',
  });
  const result = await port.runPipeline(STUB_RUN_INPUT);

  assert.equal(result.kind, 'completed');
  assert.equal(result.output.ok, false);
  assert.equal(result.output.error?.code, 'hermes_gateway_not_configured');
  assert.match(result.output.error?.message ?? '', /INTERNAL_API_SECRET/);
});

test('HermesMarketingPort marks accepted Aries runs failed when Hermes submission fails', async () => {
  await withDataRoot(async () => {
    const { loadExecutionRunRecord } = await import('../backend/execution/run-store');
    const { fetchImpl } = recordingFetchSequence([
      () => new Response(JSON.stringify({ error: 'no capacity' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const port = new HermesMarketingPort(
      {
        HERMES_GATEWAY_URL: TEST_HERMES_GATEWAY_URL,
        HERMES_API_SERVER_KEY: 'token-123',
        INTERNAL_API_SECRET: 'internal-secret',
        APP_BASE_URL: 'https://aries.example.com',
      },
      fetchImpl,
    );

    const result = await port.runPipeline(STUB_RUN_INPUT);

    assert.equal(result.kind, 'completed');
    assert.equal(result.output.ok, false);
    const detail = result.output.output as Record<string, unknown>;
    const ariesRunId = String(detail.aries_run_id);
    const stored = loadExecutionRunRecord(ariesRunId);
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.last_error?.code, 'hermes_gateway_request_failed');
  });
});
