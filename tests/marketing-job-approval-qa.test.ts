import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import React from 'react';

import { MarketingJobApproveScreen } from '../frontend/marketing/job-approve';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-approval-qa-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
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

function authRequiredLoader(): never {
  throw new Error('Authentication required.');
}

async function writeRuntimeDoc(jobId: string, tenantId = 'tenant_auth_order') {
  const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
  await mkdir(jobsRoot, { recursive: true });
  await writeFile(
    path.join(jobsRoot, `${jobId}.json`),
    JSON.stringify(
      {
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        tenant_id: tenantId,
        job_type: 'brand_campaign',
        state: 'running',
        status: 'awaiting_approval',
        current_stage: 'strategy',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          strategy: {
            stage: 'strategy',
            status: 'awaiting_approval',
            started_at: null,
            completed_at: null,
            failed_at: null,
            run_id: null,
            summary: null,
            primary_output: null,
            outputs: {},
            artifacts: [],
            errors: [],
          },
        },
        approvals: {
          current: {
            stage: 'strategy',
            status: 'awaiting_approval',
            approval_id: 'mkta_auth_order',
            workflow_step_id: 'approve_stage_2',
            requested_at: '2026-04-27T00:00:00.000Z',
            title: 'Strategy approval required',
            message: 'Approve strategy before continuing.',
            action_label: 'Review strategy',
          },
          history: [],
        },
        publish_config: {
          platforms: [],
          live_publish_platforms: [],
          video_render_platforms: [],
        },
        brand_kit: {
          source_url: 'https://brand.example',
          extracted_at: '2026-04-27T00:00:00.000Z',
        },
        inputs: {
          request: { brandUrl: 'https://brand.example' },
          brand_url: 'https://brand.example',
          competitor_url: 'https://competitor.example',
        },
        errors: [],
        last_error: null,
        history: [],
        created_at: '2026-04-27T00:00:00.000Z',
        updated_at: '2026-04-27T00:00:00.000Z',
      },
      null,
      2,
    ),
  );
}

function baseStatus(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'mkt_ui_gate',
    tenantName: 'Tenant',
    brandWebsiteUrl: 'https://brand.example',
    campaignWindow: null,
    durationDays: 14,
    plannedPostCount: 0,
    createdPostCount: 0,
    assetPreviewCards: [],
    calendarEvents: [],
    marketing_job_state: 'approval_required',
    marketing_job_status: 'awaiting_approval',
    marketing_stage: 'strategy',
    marketing_stage_status: { strategy: 'awaiting_approval' },
    updatedAt: '2026-04-27T00:00:00.000Z',
    needs_attention: true,
    approvalRequired: true,
    summary: { headline: 'Approval required', subheadline: 'Review strategy', trustNote: 'Approval is required.' },
    stageCards: [],
    artifacts: [],
    timeline: [],
    approval: {
      required: true,
      status: 'awaiting_approval',
      approvalId: 'mkta_ui_gate',
      workflowStepId: 'approve_stage_2',
      title: 'Strategy approval required',
      message: 'Review strategy before continuing.',
      actionLabel: 'Review strategy',
      actionHref: '/marketing/reviews/mkt_ui_gate%3A%3Aapproval',
    },
    reviewBundle: null,
    campaignBrief: null,
    workflowState: 'waiting_on_approval',
    statusHistory: [],
    brandReview: null,
    strategyReview: null,
    creativeReview: null,
    publishConfig: {
      platforms: [],
      livePublishPlatforms: [],
      videoRenderPlatforms: [],
    },
    nextStep: 'submit_approval',
    repairStatus: 'not_required',
    dashboard: {
      assets: [],
      posts: [],
      publishItems: [],
    },
    ...overrides,
  };
}

function findApproveButton(root: import('react-test-renderer').ReactTestRenderer) {
  const buttons = root.root.findAllByType('button');
  const button = buttons.find((entry) => JSON.stringify(entry.props.children).includes('Approve and Resume'));
  assert.ok(button, 'Approve and Resume button should render');
  return button;
}

test('MarketingJobApproveScreen keeps Approve and Resume disabled after status auth failure', async () => {
  const previousFetch = globalThis.fetch;
  const globalWithWindow = globalThis as Record<string, unknown>;
  const previousWindow = globalWithWindow.window;
  let postCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'POST') {
      postCalls += 1;
      return new Response(JSON.stringify({ approval_status: 'resumed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ reason: 'tenant_context_required', message: 'Authentication required.' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  globalWithWindow.window = globalThis;

  try {
    const { act, create } = await import('react-test-renderer');
    let root!: import('react-test-renderer').ReactTestRenderer;

    await act(async () => {
      root = create(
        React.createElement(MarketingJobApproveScreen, {
          baseUrl: 'http://localhost',
          defaultJobId: 'mkt_ui_gate',
          defaultApprovedBy: 'Reviewer',
        }),
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const approveButton = findApproveButton(root);
    assert.equal(approveButton.props.disabled, true);
    assert.match(JSON.stringify(root.toJSON()), /Authentication required/);

    await act(async () => {
      await approveButton.props.onClick();
      await flushMicrotasks();
    });
    assert.equal(postCalls, 0, 'status failure must not allow a POST approval request');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = previousWindow;
    }
  }
});

test('MarketingJobApproveScreen enables approval only for the loaded job with an active checkpoint', async () => {
  const previousFetch = globalThis.fetch;
  const globalWithWindow = globalThis as Record<string, unknown>;
  const previousWindow = globalWithWindow.window;

  globalThis.fetch = (async () =>
    new Response(JSON.stringify(baseStatus()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  globalWithWindow.window = globalThis;

  try {
    const { act, create } = await import('react-test-renderer');
    let root!: import('react-test-renderer').ReactTestRenderer;

    await act(async () => {
      root = create(
        React.createElement(MarketingJobApproveScreen, {
          baseUrl: 'http://localhost',
          defaultJobId: 'mkt_ui_gate',
          defaultApprovedBy: 'Reviewer',
        }),
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    assert.equal(findApproveButton(root).props.disabled, false);

    const jobIdInput = root.root.findByProps({ placeholder: 'mkt_...' });
    await act(async () => {
      jobIdInput.props.onChange({ target: { value: 'mkt_other_job' } });
      await flushMicrotasks();
    });

    assert.equal(findApproveButton(root).props.disabled, true, 'changing the job id must clear the loaded approval gate');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = previousWindow;
    }
  }
});

test('MarketingJobApproveScreen keeps approval disabled when loaded status has no active approval checkpoint', async () => {
  const previousFetch = globalThis.fetch;
  const globalWithWindow = globalThis as Record<string, unknown>;
  const previousWindow = globalWithWindow.window;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify(baseStatus({
        approvalRequired: false,
        approval: null,
        marketing_job_state: 'running',
        marketing_job_status: 'running',
        needs_attention: false,
      })),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    )) as typeof fetch;
  globalWithWindow.window = globalThis;

  try {
    const { act, create } = await import('react-test-renderer');
    let root!: import('react-test-renderer').ReactTestRenderer;

    await act(async () => {
      root = create(
        React.createElement(MarketingJobApproveScreen, {
          baseUrl: 'http://localhost',
          defaultJobId: 'mkt_ui_gate',
          defaultApprovedBy: 'Reviewer',
        }),
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    assert.equal(findApproveButton(root).props.disabled, true);
    assert.match(JSON.stringify(root.toJSON()), /No approval required/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = previousWindow;
    }
  }
});

test('/api/marketing/jobs/:jobId/approve authenticates before revealing runtime job existence', async () => {
  await withRuntimeEnv(async () => {
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');
    const existingJobId = 'mkt_auth_order_existing';
    const missingJobId = 'mkt_auth_order_missing';
    await writeRuntimeDoc(existingJobId);

    const getMissing = await handleGetMarketingJobStatus(missingJobId, authRequiredLoader);
    const postMissing = await handleApproveMarketingJob(
      missingJobId,
      new Request(`http://localhost/api/marketing/jobs/${missingJobId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvedBy: 'Reviewer', approvedStages: ['strategy'] }),
      }),
      authRequiredLoader,
    );
    const postExisting = await handleApproveMarketingJob(
      existingJobId,
      new Request(`http://localhost/api/marketing/jobs/${existingJobId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvedBy: 'Reviewer', approvedStages: ['strategy'] }),
      }),
      authRequiredLoader,
    );

    const getMissingBody = (await getMissing.json()) as Record<string, unknown>;
    const postMissingBody = (await postMissing.json()) as Record<string, unknown>;
    const postExistingBody = (await postExisting.json()) as Record<string, unknown>;

    assert.equal(getMissing.status, 403);
    assert.equal(postMissing.status, getMissing.status);
    assert.equal(postExisting.status, getMissing.status);
    assert.equal(getMissingBody.message, 'Authentication required.');
    assert.equal(postMissingBody.message, getMissingBody.message);
    assert.equal(postExistingBody.message, getMissingBody.message);
    assert.equal(postMissingBody.reason, getMissingBody.reason);
    assert.equal(postExistingBody.reason, getMissingBody.reason);
    assert.notEqual(postMissingBody.reason, 'marketing_job_not_found');
  });
});
