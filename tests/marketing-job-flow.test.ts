import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isValidElement } from 'react';

import MarketingNewJobPage from '../app/marketing/new-job/page';
import MarketingNewJobScreen from '../frontend/marketing/new-job';

async function loadStartMarketingJob() {
  const module = await import('../backend/marketing/jobs-start');
  return module.startMarketingJob;
}

async function withMarketingRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-'));

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

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

test('/marketing/new-job uses the canonical MarketingNewJobScreen', () => {
  const element = MarketingNewJobPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingNewJobScreen);
});

test('startMarketingJob rejects brand_campaign requests without both required URLs', async () => {
  await withMarketingRuntimeEnv(async () => {
    const startMarketingJob = await loadStartMarketingJob();

    await assert.rejects(
      () =>
        startMarketingJob({
          tenantId: 'tenant_123',
          jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://brand.example',
          },
        }),
      /missing_required_fields:.*competitorUrl/i,
    );

    await assert.rejects(
      () =>
        startMarketingJob({
          tenantId: 'tenant_123',
          jobType: 'brand_campaign',
          payload: {
            competitorUrl: 'https://facebook.com/competitor',
          },
        }),
      /missing_required_fields:.*brandUrl/i,
    );
  });
});

test('startMarketingJob uses repo-managed runtime without requiring N8N env', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    setOpenClawTestInvoker(() => ({
      ok: true,
      status: 'ok',
      output: [{ approval_preview: { status: 'pending_human_review' } }],
      requiresApproval: null,
    }));
    const startMarketingJob = await loadStartMarketingJob();
    const result = await startMarketingJob({
      tenantId: 'tenant_123',
      jobType: 'brand_campaign',
      payload: {
        brandUrl: 'https://brand.example',
        competitorUrl: 'https://facebook.com/competitor',
      },
    });

    assert.equal(result.jobType, 'brand_campaign');
    assert.equal(result.wiring, 'openclaw_gateway');
    assert.equal(result.jobId.includes('tenant_123'), false);

    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${result.jobId}.json`);
    const runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as {
      job_type?: string;
      inputs?: {
        brand_url?: string;
        competitor_url?: string;
      };
    };

    assert.equal(runtimeDoc.job_type, 'brand_campaign');
    assert.equal(runtimeDoc.inputs?.brand_url, 'https://brand.example');
    assert.equal(runtimeDoc.inputs?.competitor_url, 'https://facebook.com/competitor');
    clearOpenClawTestInvoker();
  });
});

test('approveMarketingJob rejects tenant mismatches for local runtime jobs', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', 'mkt_tenant-a_1.json');
    await mkdir(path.dirname(runtimeFile), { recursive: true });

    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'job_runtime_state_schema',
        schema_version: '1.0.0',
        job_id: 'mkt_tenant-a_1',
        job_type: 'brand_campaign',
        tenant_id: 'tenant-a',
        state: 'queued',
        status: 'pending',
        attempt: 1,
        max_attempts: 3,
        outputs: {
          current_stage: 'research',
          stage_status: {
            research: 'queued',
            strategy: 'paused',
            production: 'paused',
            publish: 'paused',
          },
          structured_status_updates: [],
        },
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2)
    );

    const result = await approveMarketingJob({
      jobId: 'mkt_tenant-a_1',
      tenantId: 'tenant-b',
      approvedBy: 'operator',
      approvedStages: ['research'],
    });

    assert.equal(result.status, 'error');
    assert.equal(result.resumedStage, null);
    assert.equal(result.completed, false);
    assert.equal(result.wiring, 'openclaw_gateway');
  });
});

test('approveMarketingJob resumes the real OpenClaw token and marks publish complete', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const { approveMarketingJob } = await import('../backend/marketing/jobs-approve');
    const jobId = 'mkt_resume_real_1';
    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'job_runtime_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant-a',
        state: 'approval_required',
        status: 'awaiting_approval',
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
          openclaw: {
            run_id: 'demo-run-approve',
            resume_token: 'resume_123',
            primary_output: {
              run_id: 'demo-run-approve',
              approval_preview: {
                status: 'pending_human_review',
              },
            },
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
        output: [{
          run_id: 'demo-run-approve',
          summary: {
            message: 'Publish packages ready.',
          },
        }],
        requiresApproval: null,
      };
    });

    const result = await approveMarketingJob({
      jobId,
      tenantId: 'tenant-a',
      approvedBy: 'operator',
      approvedStages: ['publish'],
      resumePublishIfNeeded: true,
    });
    const runtimeDoc = JSON.parse(await readFile(runtimeFile, 'utf8')) as Record<string, any>;

    assert.equal(result.status, 'resumed');
    assert.equal(result.resumedStage, 'publish');
    assert.equal(result.completed, true);
    assert.equal((captured as any)?.args?.action, 'resume');
    assert.equal((captured as any)?.args?.token, 'resume_123');
    assert.equal(runtimeDoc.state, 'completed');
    assert.equal(runtimeDoc.status, 'completed');
    assert.equal(runtimeDoc.outputs?.stage_status?.publish, 'completed');
    assert.equal(runtimeDoc.outputs?.openclaw?.resume_token, null);
    clearOpenClawTestInvoker();
  });
});
