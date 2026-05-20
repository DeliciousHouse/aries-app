import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// ---------------------------------------------------------------------------
// Phase B3 — weekly resume → run conversion
//
// A resume_token issued by one profile's gateway cannot resume on another
// gateway. For the weekly social pipeline, strategy/production/publish must be
// dispatched as fresh `action: run` POSTs carrying the prior stage's output.
// ---------------------------------------------------------------------------

const WEEKLY_WORKFLOW_KEY = 'social_content_weekly';

/**
 * Seed a minimal marketing job runtime doc under DATA_ROOT so the port's
 * loadMarketingJobRuntime() resolves prior-stage outputs for the resume→run
 * conversion.
 */
async function seedWeeklyJobDoc(jobId: string): Promise<void> {
  const ts = new Date().toISOString();
  const stageRecord = (
    stage: string,
    status: string,
    primaryOutput: Record<string, unknown> | null,
  ) => ({
    stage,
    status,
    started_at: ts,
    completed_at: status === 'completed' ? ts : null,
    failed_at: null,
    run_id: `run-${stage}`,
    summary: null,
    primary_output: primaryOutput,
    outputs: {},
    artifacts: [],
    errors: [],
  });
  const doc = {
    schema_name: 'marketing_job_state_schema',
    schema_version: '1.0.0',
    job_id: jobId,
    tenant_id: 'tenant_test',
    job_type: 'weekly_social_content',
    state: 'running',
    status: 'running',
    current_stage: 'production',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    stages: {
      research: stageRecord('research', 'completed', { positioning: 'RESEARCH_MARKER' }),
      strategy: stageRecord('strategy', 'completed', { strategySummary: 'STRATEGY_MARKER' }),
      production: stageRecord('production', 'completed', { content_package: ['PRODUCTION_MARKER'] }),
      publish: stageRecord('publish', 'not_started', null),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: { brand_name: 'Brand Co' },
    inputs: {
      brand_url: 'https://brand.example',
      request: { jobType: 'weekly_social_content', channels: ['instagram', 'meta'], imageCreativeCount: 7 },
    },
    created_at: ts,
    updated_at: ts,
    history: [],
  };
  const dir = path.join(process.env.DATA_ROOT as string, 'generated', 'draft', 'marketing-jobs');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${jobId}.json`), JSON.stringify(doc, null, 2), 'utf8');
}

function weeklyResumeInput(stage: 'strategy' | 'production' | 'publish', jobId: string) {
  return {
    resumeToken: 'prior-checkpoint-token',
    approve: true,
    tenantId: 'tenant_test',
    jobId,
    approvalId: 'approval_1',
    stage,
    workflowStepId: 'approve_stage_x',
    approvalStep: null,
    workflowKey: WEEKLY_WORKFLOW_KEY,
  };
}

test('weekly strategy resume is dispatched as action:run carrying research output', async () => {
  await withDataRoot(async () => {
    await seedWeeklyJobDoc('job_weekly_1');
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    await port.resumePipeline(weeklyResumeInput('strategy', 'job_weekly_1'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://host.docker.internal:8654/v1/runs');
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    assert.equal(body.action, 'run', 'weekly strategy resume must convert to action:run');
    assert.equal(body.resume_token, undefined, 'no resume_token — tokens do not cross gateways');
    assert.ok(
      String(body.input).includes('RESEARCH_MARKER'),
      'strategy run input must carry the prior research stage output',
    );
  });
});

test('weekly production resume is dispatched as action:run carrying strategy output', async () => {
  await withDataRoot(async () => {
    await seedWeeklyJobDoc('job_weekly_2');
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    await port.resumePipeline(weeklyResumeInput('production', 'job_weekly_2'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://host.docker.internal:8655/v1/runs');
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    assert.equal(body.action, 'run', 'weekly production resume must convert to action:run');
    assert.equal(body.resume_token, undefined, 'no resume_token — tokens do not cross gateways');
    assert.ok(
      String(body.input).includes('STRATEGY_MARKER'),
      'production run input must carry the prior strategy stage output',
    );
    assert.ok(
      String(body.input).includes('Production context ('),
      'production run input must carry the per-image prompt context block',
    );
  });
});

test('weekly publish resume is dispatched as action:run carrying production output', async () => {
  await withDataRoot(async () => {
    await seedWeeklyJobDoc('job_weekly_3');
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    await port.resumePipeline(weeklyResumeInput('publish', 'job_weekly_3'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://host.docker.internal:8654/v1/runs');
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    assert.equal(body.action, 'run', 'weekly publish resume must convert to action:run');
    assert.equal(body.resume_token, undefined, 'no resume_token — tokens do not cross gateways');
    assert.ok(
      String(body.input).includes('PRODUCTION_MARKER'),
      'publish run input must carry the prior production stage output',
    );
  });
});

test('weekly stage runs ship only their own stage instruction contract', async () => {
  await withDataRoot(async () => {
    await seedWeeklyJobDoc('job_weekly_4');
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    await port.resumePipeline(weeklyResumeInput('strategy', 'job_weekly_4'));
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    const instructions = String(body.instructions);
    assert.ok(instructions.includes('strategist'), 'strategy run must carry the strategist contract');
    assert.ok(
      !instructions.includes('image_generate'),
      'strategy run instructions must NOT mention image_generate (that is the production profile)',
    );
  });
});

test('stage-less weekly resume infers the stage from approvalStep and routes correctly', async () => {
  // The resume-state reseed path resumes by token only with no explicit
  // stage. The port must infer the stage from the approval step so the
  // submission still routes to the correct per-profile gateway instead of
  // falling back to research.
  await withDataRoot(async () => {
    await seedWeeklyJobDoc('job_weekly_infer');
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    await port.resumePipeline({
      resumeToken: 'prior-checkpoint-token',
      approve: true,
      tenantId: 'tenant_test',
      jobId: 'job_weekly_infer',
      approvalId: 'approval_1',
      stage: null,
      workflowStepId: 'approve_stage_3',
      approvalStep: 'approve_post_copy',
      workflowKey: WEEKLY_WORKFLOW_KEY,
    });
    assert.equal(calls.length, 1);
    // approve_post_copy resumes INTO production -> content-generator gateway.
    assert.equal(calls[0].url, 'http://host.docker.internal:8655/v1/runs');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer content-key');
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    assert.equal(body.action, 'run');
    assert.ok(String(body.input).includes('Stage: production'));
  });
});

test('weekly DENIAL skips the Hermes POST entirely (cancelled envelope)', async () => {
  await withDataRoot(async () => {
    await seedWeeklyJobDoc('job_weekly_deny');
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    const result = await port.resumePipeline({
      ...weeklyResumeInput('strategy', 'job_weekly_deny'),
      approve: false,
    });
    // A weekly denial has nothing to cancel — the stage's Hermes run already
    // completed when it emitted the approval checkpoint. The port skips the
    // POST entirely and returns a synthetic `cancelled` envelope; the
    // orchestrator records the denial and fails the job locally.
    assert.equal(calls.length, 0, 'a weekly denial must not POST to any Hermes gateway');
    assert.equal(result.kind, 'completed');
    if (result.kind === 'completed') {
      assert.equal(result.output.status, 'cancelled');
      assert.equal(result.output.ok, true);
      assert.equal(result.output.workflowKey, WEEKLY_WORKFLOW_KEY);
    }
  });
});

test('brand-campaign (marketing_pipeline) resume still uses action:resume with resume_token', async () => {
  await withDataRoot(async () => {
    const { calls, fetchImpl } = recordingFetch();
    const port = makePort(PER_PROFILE_ENV, fetchImpl as unknown as typeof fetch);
    await port.resumePipeline(resumeInput('strategy'));
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    // The brand-campaign path is NOT decomposed — it keeps the combined,
    // single-gateway resume shape.
    assert.notEqual(body.action, 'run', 'brand-campaign resume must not convert to action:run');
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
