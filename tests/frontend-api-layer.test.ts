import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { POST as postOnboardingStart } from '../app/api/onboarding/start/route';
import { GET as getOnboardingStatus } from '../app/api/onboarding/status/[tenantId]/route';

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-frontend-api-'));

  process.env.CODE_ROOT = process.cwd();
  process.env.DATA_ROOT = dataRoot;

  try {
    return await run(dataRoot);
  } finally {
    if (previousCodeRoot === undefined) {
      delete process.env.CODE_ROOT;
    } else {
      process.env.CODE_ROOT = previousCodeRoot;
    }

    if (previousDataRoot === undefined) {
      delete process.env.DATA_ROOT;
    } else {
      process.env.DATA_ROOT = previousDataRoot;
    }

    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('/api/onboarding/start returns a frontend-safe payload without workflow internals', async () => {
  setOpenClawTestInvoker(() => ({
    ok: true,
    status: 'ok',
    output: [{ accepted: true }],
    requiresApproval: null,
  }));

  const response = await postOnboardingStart(
    new Request('http://localhost/api/onboarding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant_id: 'tenant_123',
        tenant_type: 'single_user',
        signup_event_id: 'signup_evt_456',
      }),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.tenant_id, 'tenant_123');
  assert.equal(body.tenant_type, 'single_user');
  assert.equal(body.signup_event_id, 'signup_evt_456');
  assert.equal(body.onboarding_status, 'accepted');
  assert.equal('workflow_status' in body, false);
  assert.equal('raw' in body, false);
  clearOpenClawTestInvoker();
});

test('/api/onboarding/status exposes artifact booleans instead of runtime paths', async () => {
  const response = await getOnboardingStatus(
    new Request('http://localhost/api/onboarding/status/tenant_123?signup_event_id=signup_evt_456'),
    { params: Promise.resolve({ tenantId: 'tenant_123' }) },
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.onboarding_status, 'ok');
  assert.equal(body.tenant_id, 'tenant_123');
  assert.equal('artifacts' in body, true);
  assert.equal('progress_hint' in body, true);
  assert.equal('paths' in body, false);
  assert.equal('pathsAreRelative' in body, false);
});

test('/api/marketing/jobs resolves tenant context server-side and returns a frontend-safe payload', async () => {
  await withRuntimeEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    let captured: Record<string, unknown> | null = null;
    setOpenClawTestInvoker((payload) => {
      captured = payload;
      return {
        ok: true,
        status: 'ok',
        output: [{ accepted: true, approval_preview: { status: 'pending_human_review' } }],
        requiresApproval: { resumeToken: 'resume_123' },
      };
    });

    const response = await handlePostMarketingJobs(
      new Request('http://localhost/api/marketing/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'forged_tenant',
          jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://brand.example',
            competitorUrl: 'https://facebook.com/competitor',
          },
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as Record<string, unknown>;
    const workflowArgs = JSON.parse(String((captured as any)?.args?.argsJson)) as Record<string, unknown>;

    assert.equal(response.status, 202);
    assert.equal(body.marketing_job_status, 'accepted');
    assert.equal(body.jobType, 'brand_campaign');
    assert.equal(body.approvalRequired, true);
    assert.equal(typeof body.jobStatusUrl, 'string');
    assert.equal('tenantId' in body, false);
    assert.equal('wiring' in body, false);
    assert.equal('runtimeArtifactPath' in body, false);
    assert.equal('runtimePath' in body, false);
    assert.equal('runtimePathDeprecated' in body, false);
    assert.equal(String(body.jobId).includes('tenant_real'), false);
    assert.equal(workflowArgs.brand_slug, 'tenant_real');
    assert.equal(workflowArgs.website_url, 'https://brand.example');
    assert.equal(workflowArgs.competitor_facebook_url, 'https://facebook.com/competitor');
    clearOpenClawTestInvoker();
  });
});

test('/api/marketing/jobs returns onboarding_required when tenant context has not been established', async () => {
  const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
  const response = await handlePostMarketingJobs(
    new Request('http://localhost/api/marketing/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobType: 'brand_campaign',
        payload: {
          brandUrl: 'https://brand.example',
          competitorUrl: 'https://facebook.com/competitor',
        },
      }),
    }),
    async () => {
      throw new Error('No tenant membership found for authenticated user.');
    }
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 409);
  assert.equal(body.status, 'error');
  assert.equal(body.reason, 'onboarding_required');
  assert.equal(body.message, 'Complete tenant onboarding before starting a brand campaign.');
});

test('/api/marketing/jobs/:jobId omits runtime path fields and resolves approval state for the current tenant', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_safe_job';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'job_runtime_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_real',
        state: 'running',
        status: 'pending',
        attempt: 1,
        max_attempts: 3,
        outputs: {
          current_stage: 'publish',
          stage_status: {
            research: 'submitted',
            strategy: 'submitted',
            production: 'submitted',
            publish: 'awaiting_approval',
          },
          openclaw: {
            resume_token: 'resume_123',
          },
          structured_status_updates: [],
        },
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.jobId, jobId);
    assert.equal(body.marketing_job_state, 'running');
    assert.equal(body.marketing_job_status, 'pending');
    assert.equal(body.needs_attention, false);
    assert.equal(body.approvalRequired, true);
    assert.equal('tenantId' in body, false);
    assert.equal('runtimeArtifactPath' in body, false);
    assert.equal('runtimePath' in body, false);
    assert.equal('runtimePathDeprecated' in body, false);
  });
});

test('/api/marketing/jobs/:jobId hides jobs owned by a different tenant', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const jobId = 'mkt_hidden_job';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'job_runtime_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_other',
        state: 'running',
        status: 'pending',
        outputs: {
          current_stage: 'publish',
          stage_status: {},
          structured_status_updates: [],
        },
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const response = await handleGetMarketingJobStatus(
      jobId,
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 404);
    assert.equal(body.error, 'Marketing job not found.');
    assert.equal(body.reason, 'marketing_job_not_found');
  });
});

test('/api/marketing/jobs/:jobId/approve resolves tenant context server-side and returns a product-safe payload', async () => {
  await withRuntimeEnv(async () => {
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');
    const jobId = 'mkt_approve_job';
    const runtimeFile = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'job_runtime_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_real',
        state: 'waiting_repair',
        status: 'pending',
        attempt: 1,
        max_attempts: 3,
        outputs: {
          current_stage: 'publish',
          stage_status: {
            research: 'completed',
            strategy: 'completed',
            production: 'completed',
            publish: 'awaiting_approval',
          },
          structured_status_updates: [],
        },
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    let captured: Record<string, unknown> | null = null;
    setOpenClawTestInvoker((payload) => {
      captured = payload;
      return {
        ok: true,
        status: 'ok',
        output: [{ accepted: true }],
        requiresApproval: null,
      };
    });

    const response = await handleApproveMarketingJob(
      jobId,
      new Request(`http://localhost/api/marketing/jobs/${jobId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'forged_tenant',
          approvedBy: 'operator',
          approvedStages: ['publish'],
          resumePublishIfNeeded: true,
        }),
      }),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin',
      })
    );
    const body = (await response.json()) as Record<string, unknown>;
    const workflowArgs = JSON.parse(String((captured as any)?.args?.argsJson)) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.approval_status, 'resumed');
    assert.equal(body.jobId, jobId);
    assert.equal(typeof body.jobStatusUrl, 'string');
    assert.equal('tenantId' in body, false);
    assert.equal('wiring' in body, false);
    assert.equal(workflowArgs.tenant_id, 'tenant_real');
    assert.equal(workflowArgs.job_id, jobId);
    clearOpenClawTestInvoker();
  });
});
