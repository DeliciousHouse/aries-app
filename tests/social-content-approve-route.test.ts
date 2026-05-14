import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY } from '@/backend/social-content/defaults';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const previousGatewayUrl = process.env.HERMES_GATEWAY_URL;
  const previousGatewayKey = process.env.HERMES_API_SERVER_KEY;
  const previousInternalSecret = process.env.INTERNAL_API_SECRET;
  const previousAppBaseUrl = process.env.APP_BASE_URL;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-social-approve-route-'));

  process.env.DATA_ROOT = dataRoot;
  process.env.HERMES_GATEWAY_URL = 'https://hermes.example.com';
  process.env.HERMES_API_SERVER_KEY = 'hermes-key';
  process.env.HERMES_POLL_BRIDGE_ENABLED = '0';
  process.env.INTERNAL_API_SECRET = 'internal-secret';
  process.env.APP_BASE_URL = 'https://aries.example.com';

  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousGatewayUrl === undefined) delete process.env.HERMES_GATEWAY_URL;
    else process.env.HERMES_GATEWAY_URL = previousGatewayUrl;
    if (previousGatewayKey === undefined) delete process.env.HERMES_API_SERVER_KEY;
    else process.env.HERMES_API_SERVER_KEY = previousGatewayKey;
    if (previousInternalSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previousInternalSecret;
    if (previousAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousAppBaseUrl;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

type SocialApprovalStep =
  | 'approve_weekly_plan'
  | 'approve_post_copy'
  | 'approve_image_creatives'
  | 'approve_video_script'
  | 'approve_video_render'
  | 'approve_publish';

function marketingStageForStep(step: SocialApprovalStep): 'strategy' | 'production' | 'publish' {
  if (step === 'approve_weekly_plan') {
    return 'strategy';
  }
  if (step === 'approve_publish') {
    return 'publish';
  }
  return 'production';
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
}

async function seedWeeklyApproval(input: {
  jobId: string;
  tenantId: string;
  approvalId: string;
  approvalStep: SocialApprovalStep;
  workflowStepId: string;
  resumeToken: string;
  publishRequested?: boolean;
}) {
  const {
    createMarketingJobRuntimeDocument,
    markStageAwaitingApproval,
    saveMarketingJobRuntime,
  } = await import('../backend/marketing/runtime-state');
  const { ensureSocialContentRuntimeState } = await import('../backend/social-content/runtime-state');
  const { createMarketingApprovalRecord, saveMarketingApprovalRecord } = await import('../backend/marketing/approval-store');

  const stage = marketingStageForStep(input.approvalStep);
  const doc = createMarketingJobRuntimeDocument({
    jobId: input.jobId,
    tenantId: input.tenantId,
    payload: {
      jobType: 'weekly_social_content',
      brandUrl: 'https://brand.example',
      businessType: 'B2B SaaS',
      primaryGoal: 'Book demos',
      ...(typeof input.publishRequested === 'boolean'
        ? { publishRequested: input.publishRequested }
        : {}),
      channels: ['meta', 'instagram'],
    },
    brandKit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://brand.example',
      canonical_url: 'https://brand.example',
      brand_name: 'Brand',
      logo_urls: [],
      colors: {
        primary: null,
        secondary: null,
        accent: null,
        palette: [],
      },
      font_families: [],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: null,
      offer_summary: null,
    },
    createdBy: 'user-social-approve',
  });

  if (typeof input.publishRequested === 'boolean') {
    ensureSocialContentRuntimeState(doc, { publishingRequested: input.publishRequested });
  } else {
    ensureSocialContentRuntimeState(doc);
  }
  markStageAwaitingApproval(
    doc,
    stage,
    {
      approval_id: input.approvalId,
      workflow_name: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
      workflow_step_id: input.workflowStepId,
      title: 'Approval required',
      message: 'Approve to continue.',
      resume_token: input.resumeToken,
      action_label: 'Approve',
    },
    {
      summary: { summary: 'Awaiting approval.' },
      outputs: {
        approval_step: input.approvalStep,
      },
    },
  );
  saveMarketingJobRuntime(doc.job_id, doc);

  const approvalRecord = createMarketingApprovalRecord({
    approvalId: input.approvalId,
    tenantId: input.tenantId,
    marketingJobId: input.jobId,
    workflowName: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
    workflowStepId: input.workflowStepId,
    socialContentApprovalStep: input.approvalStep,
    marketingStage: stage,
    executionProvider: 'hermes',
    executionResumeToken: input.resumeToken,
    approvalPrompt: 'Approve to continue.',
    runtimeContext: {
      pipelinePath: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
      cwd: 'hermes',
      sessionKey: 'marketing',
    },
  });
  saveMarketingApprovalRecord(approvalRecord);
}

function tenantLoader() {
  return async () => ({
    userId: 'user-social-approve',
    tenantId: 'tenant-social-approve',
    tenantSlug: 'tenant-social-approve',
    role: 'tenant_admin' as const,
  });
}

test('plan approval submits Hermes resume request body', async () => {
  await withRuntimeEnv(async () => {
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');
    const { loadMarketingApprovalRecord } = await import('../backend/marketing/approval-store');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const jobId = 'job-social-plan';
    const approvalId = 'mkta_social_plan';
    await seedWeeklyApproval({
      jobId,
      tenantId: 'tenant-social-approve',
      approvalId,
      approvalStep: 'approve_weekly_plan',
      workflowStepId: 'approve_weekly_plan',
      resumeToken: 'resume-weekly-plan',
    });

    const previousFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      calls.push({ url: String(input), body });
      return new Response(JSON.stringify({ run_id: 'hermes-run-social-plan', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const response = await handleApproveMarketingJob(
        jobId,
        new Request(`http://localhost/api/social-content/jobs/${jobId}/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            approvedBy: 'operator',
            approvalId,
            approvalStep: 'approve_weekly_plan',
            approved: true,
          }),
        }),
        tenantLoader(),
        { responseDialect: 'social-content' },
      );
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 202);
      assert.equal(body.social_content_approval_status, 'submitted');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.workflow_key, 'social_content_weekly');
      assert.equal(calls[0].body.action, 'resume');
      assert.equal(typeof calls[0].body.aries_run_id, 'string');
      assert.equal(calls[0].body.approval_step, 'approve_weekly_plan');
      assert.equal(calls[0].body.approval_id, approvalId);
      assert.equal(calls[0].body.resume_token, 'resume-weekly-plan');
      assert.equal(calls[0].body.approved, true);
      assert.equal(calls[0].body.job_id, jobId);
      assert.equal(calls[0].body.tenant_id, 'tenant-social-approve');
      assert.equal(calls[0].body.callback_url, 'https://aries.example.com/api/internal/hermes/runs');
      const callbackAuth = calls[0].body.callback_auth;
      assertPlainRecord(callbackAuth, 'callback_auth');
      assert.equal(callbackAuth.type, 'internal_api_secret_bearer');
      assert.equal(callbackAuth.secret_ref, 'INTERNAL_API_SECRET');
      assert.match(String(callbackAuth.callback_token), /^[0-9a-f]{64}$/);
      assert.deepEqual(calls[0].body.callback_context, {
        workflow_key: 'social_content_weekly',
        aries_run_id: calls[0].body.aries_run_id,
        job_id: jobId,
        tenant_id: 'tenant-social-approve',
        approval_id: approvalId,
        approval_step: 'approve_weekly_plan',
      });
      const savedRecord = loadMarketingApprovalRecord(approvalId);
      assert.equal(savedRecord?.status, 'approved');
      const runtimeDoc = await loadMarketingJobRuntime(jobId);
      assert.equal(runtimeDoc?.social_content_runtime?.currentStage, 'copy_production');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('stale approval id cannot resume social-content job', async () => {
  await withRuntimeEnv(async () => {
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');
    const { createMarketingApprovalRecord, saveMarketingApprovalRecord } = await import('../backend/marketing/approval-store');

    const jobId = 'job-social-stale';
    await seedWeeklyApproval({
      jobId,
      tenantId: 'tenant-social-approve',
      approvalId: 'mkta_social_current',
      approvalStep: 'approve_weekly_plan',
      workflowStepId: 'approve_weekly_plan',
      resumeToken: 'resume-current',
    });

    const stale = createMarketingApprovalRecord({
      approvalId: 'mkta_social_stale',
      tenantId: 'tenant-social-approve',
      marketingJobId: jobId,
      workflowName: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
      workflowStepId: 'approve_weekly_plan',
      socialContentApprovalStep: 'approve_weekly_plan',
      marketingStage: 'strategy',
      executionProvider: 'hermes',
      executionResumeToken: 'resume-stale',
      approvalPrompt: 'Stale approval',
      runtimeContext: {
        pipelinePath: SOCIAL_CONTENT_WEEKLY_WORKFLOW_KEY,
        cwd: 'hermes',
        sessionKey: 'marketing',
      },
    });
    saveMarketingApprovalRecord(stale);

    const previousFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response(JSON.stringify({ run_id: 'unexpected' }), { status: 202 });
    }) as typeof fetch;
    try {
      const response = await handleApproveMarketingJob(
        jobId,
        new Request(`http://localhost/api/social-content/jobs/${jobId}/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            approvedBy: 'operator',
            approvalId: 'mkta_social_stale',
            approvalStep: 'approve_weekly_plan',
          }),
        }),
        tenantLoader(),
        { responseDialect: 'social-content' },
      );
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 409);
      assert.equal(body.reason, 'approval_not_available');
      assert.equal(callCount, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('denied social-content approval records denied state', async () => {
  await withRuntimeEnv(async () => {
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');
    const { loadMarketingApprovalRecord } = await import('../backend/marketing/approval-store');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const jobId = 'job-social-deny';
    const approvalId = 'mkta_social_deny';
    await seedWeeklyApproval({
      jobId,
      tenantId: 'tenant-social-approve',
      approvalId,
      approvalStep: 'approve_weekly_plan',
      workflowStepId: 'approve_weekly_plan',
      resumeToken: 'resume-deny',
    });

    const previousFetch = globalThis.fetch;
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ run_id: 'hermes-run-social-deny', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const response = await handleApproveMarketingJob(
        jobId,
        new Request(`http://localhost/api/social-content/jobs/${jobId}/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            approvedBy: 'operator',
            approvalId,
            approvalStep: 'approve_weekly_plan',
            approved: false,
          }),
        }),
        tenantLoader(),
        { responseDialect: 'social-content' },
      );
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 202);
      assert.equal(body.social_content_approval_status, 'submitted');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].approved, false);
      const approval = loadMarketingApprovalRecord(approvalId);
      assert.equal(approval?.status, 'denied');
      const runtime = await loadMarketingJobRuntime(jobId);
      assert.equal(runtime?.social_content_runtime?.currentStage, 'failed');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('duplicate social-content approval does not double-submit', async () => {
  await withRuntimeEnv(async () => {
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');

    const jobId = 'job-social-duplicate';
    const approvalId = 'mkta_social_duplicate';
    await seedWeeklyApproval({
      jobId,
      tenantId: 'tenant-social-approve',
      approvalId,
      approvalStep: 'approve_weekly_plan',
      workflowStepId: 'approve_weekly_plan',
      resumeToken: 'resume-duplicate',
    });

    const previousFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response(JSON.stringify({ run_id: 'hermes-run-social-dup', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const request = () =>
        handleApproveMarketingJob(
          jobId,
          new Request(`http://localhost/api/social-content/jobs/${jobId}/approve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              approvedBy: 'operator',
              approvalId,
              approvalStep: 'approve_weekly_plan',
            }),
          }),
          tenantLoader(),
          { responseDialect: 'social-content' },
        );

      const first = await request();
      const second = await request();
      const firstBody = (await first.json()) as Record<string, unknown>;
      const secondBody = (await second.json()) as Record<string, unknown>;
      assert.equal(first.status, 202);
      assert.equal(firstBody.social_content_approval_status, 'submitted');
      assert.equal(second.status, 200);
      assert.equal(secondBody.reason, 'already_resolved');
      assert.equal(callCount, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('default weekly jobs skip publish approval even with content channels', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { listMarketingApprovalRecordsForJob } = await import('../backend/marketing/approval-store');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const jobId = 'job-social-no-publish';
    await seedWeeklyApproval({
      jobId,
      tenantId: 'tenant-social-approve',
      approvalId: 'mkta_social_publish_optional',
      approvalStep: 'approve_weekly_plan',
      workflowStepId: 'approve_weekly_plan',
      resumeToken: 'resume-step-1',
    });

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: 'tenant-social-approve',
      marketingJobId: jobId,
      stage: 'publish',
      workflowStepId: 'approve_publish',
    });

    await handleHermesRunCallback({
      event_id: 'evt-social-publish-approval-optional',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-social-publish-optional',
      status: 'requires_approval',
      stage: 'publish_review',
      output: [{ summary: 'Publish review complete' }],
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_publish',
        prompt: 'Approve publish?',
        resume_token: 'resume-publish-optional',
      },
    });

    const runtime = await loadMarketingJobRuntime(jobId);
    assert.equal(runtime?.approvals.current, null);
    assert.equal(runtime?.social_content_runtime?.currentStage, 'completed');
    assert.equal(listMarketingApprovalRecordsForJob(jobId).length, 1);
  });
});

test('publish-skip reconciles in-flight intermediate social stages to completed (regression: mkt_0735c3b1)', async () => {
  // Reproduces the bug where copy_production / image_briefing / image_generation
  // were left in `running` state when the approve_publish callback fired and
  // publishing was not requested. The job went terminal but those sub-stages
  // stayed running with null output — stranding the run with no images.
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const { markSocialContentStageRunning, markSocialContentStageCompleted } = await import('../backend/social-content/runtime-state');

    const jobId = 'job-social-publish-skip-reconcile';
    await seedWeeklyApproval({
      jobId,
      tenantId: 'tenant-social-approve',
      approvalId: 'mkta_social_pubskip_reconcile',
      approvalStep: 'approve_weekly_plan',
      workflowStepId: 'approve_weekly_plan',
      resumeToken: 'resume-pubskip-1',
      publishRequested: false,
    });

    // Simulate the intermediate social stages that were running when
    // the approve_publish callback arrived (as observed in mkt_0735c3b1).
    const { loadMarketingJobRuntime: loadDoc, saveMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const doc = await loadDoc(jobId);
    assert.ok(doc, 'job doc must exist after seed');
    markSocialContentStageCompleted(doc, 'research', { summary: 'Research done.' });
    markSocialContentStageCompleted(doc, 'planning', { summary: 'Planning done.' });
    markSocialContentStageCompleted(doc, 'plan_review', { summary: 'Plan reviewed.' });
    markSocialContentStageRunning(doc, 'copy_production');   // still running — no output yet
    markSocialContentStageRunning(doc, 'image_briefing');    // still running — no output yet
    // image_generation is pending (never started)
    saveMarketingJobRuntime(doc.job_id, doc);

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: 'tenant-social-approve',
      marketingJobId: jobId,
      stage: 'publish',
      workflowStepId: 'approve_publish',
    });

    await handleHermesRunCallback({
      event_id: 'evt-pubskip-reconcile',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-pubskip-reconcile',
      status: 'requires_approval',
      stage: 'publish_review',
      output: [{ summary: 'Publish review complete' }],
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_publish',
        prompt: 'Approve publish?',
        resume_token: 'resume-publish-pubskip',
      },
    });

    const runtime = await loadMarketingJobRuntime(jobId);
    assert.ok(runtime, 'runtime must still exist after publish-skip');

    // Job must be terminal.
    assert.equal(runtime.state, 'completed');
    assert.equal(runtime.social_content_runtime?.currentStage, 'completed');

    // No intermediate stage may be left in a non-terminal state.
    const scr = runtime.social_content_runtime;
    assert.ok(scr, 'social_content_runtime must be present');
    const nonTerminalStatuses = ['running', 'pending', 'awaiting_approval'];
    const sentinelStages = new Set(['completed', 'failed']);
    for (const [stageName, stageRecord] of Object.entries(scr.stages ?? {})) {
      if (sentinelStages.has(stageName)) continue;
      const record = stageRecord as { status: string };
      assert.ok(
        !nonTerminalStatuses.includes(record.status),
        `social stage '${stageName}' must not be in non-terminal status '${record.status}' after publish-skip`,
      );
    }
  });
});

test('explicit publish request creates publish approval checkpoint', async () => {
  await withRuntimeEnv(async () => {
    const { createExecutionRunRecord } = await import('../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../backend/execution/hermes-callbacks');
    const { listMarketingApprovalRecordsForJob } = await import('../backend/marketing/approval-store');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const jobId = 'job-social-publish-explicit';
    await seedWeeklyApproval({
      jobId,
      tenantId: 'tenant-social-approve',
      approvalId: 'mkta_social_publish_explicit_seed',
      approvalStep: 'approve_weekly_plan',
      workflowStepId: 'approve_weekly_plan',
      resumeToken: 'resume-step-1',
      publishRequested: true,
    });

    const run = createExecutionRunRecord({
      provider: 'hermes',
      domain: 'marketing',
      workflowKey: 'social_content_weekly',
      action: 'resume',
      tenantId: 'tenant-social-approve',
      marketingJobId: jobId,
      stage: 'publish',
      workflowStepId: 'approve_publish',
    });

    await handleHermesRunCallback({
      event_id: 'evt-social-publish-approval-required',
      aries_run_id: run.aries_run_id,
      hermes_run_id: 'hermes-social-publish-required',
      status: 'requires_approval',
      stage: 'publish_review',
      output: [{ summary: 'Publish review complete' }],
      approval: {
        stage: 'publish',
        approval_step: 'approve_publish',
        workflow_step_id: 'approve_publish',
        prompt: 'Approve publish?',
        resume_token: 'resume-publish-required',
      },
    });

    const runtime = await loadMarketingJobRuntime(jobId);
    assert.equal(runtime?.approvals.current?.workflow_step_id, 'approve_publish');
    assert.equal(runtime?.social_content_runtime?.currentStage, 'publish_review');
    assert.equal(
      (runtime?.social_content_runtime?.activeApproval as { approvalStep?: string } | undefined)?.approvalStep,
      'approve_publish',
    );
    assert.equal(
      listMarketingApprovalRecordsForJob(jobId).some((record) => record.social_content_approval_step === 'approve_publish'),
      true,
    );
  });
});
