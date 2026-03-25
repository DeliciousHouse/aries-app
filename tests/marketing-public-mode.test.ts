import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function setOpenClawTestInvoker(
  impl: (payload: Record<string, unknown>) => unknown | Promise<unknown>
): void {
  (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = impl;
}

function clearOpenClawTestInvoker(): void {
  delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
}

async function withPublicMarketingEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousStatusPublic = process.env.MARKETING_STATUS_PUBLIC;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-public-marketing-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.MARKETING_STATUS_PUBLIC = '1';

  try {
    return await run();
  } finally {
    clearOpenClawTestInvoker();
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousLobsterCwd === undefined) delete process.env.OPENCLAW_LOBSTER_CWD;
    else process.env.OPENCLAW_LOBSTER_CWD = previousLobsterCwd;
    if (previousStatusPublic === undefined) delete process.env.MARKETING_STATUS_PUBLIC;
    else process.env.MARKETING_STATUS_PUBLIC = previousStatusPublic;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('/api/marketing/jobs allows public create when MARKETING_STATUS_PUBLIC is enabled', async () => {
  await withPublicMarketingEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    setOpenClawTestInvoker(() => ({
      ok: true,
      status: 'needs_approval',
      output: [{ run_id: 'public-run-1' }],
      requiresApproval: { resumeToken: 'resume_public_strategy', prompt: 'Continue to strategy?' },
    }));

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
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 202);
    assert.equal(body.marketing_job_status, 'accepted');
    assert.equal(typeof body.jobId, 'string');

    const runtimeDoc = loadMarketingJobRuntime(String(body.jobId));
    assert.ok(runtimeDoc);
    assert.equal(runtimeDoc?.tenant_id, 'public_brand-example');
    assert.equal(runtimeDoc?.approvals.current?.resume_token, 'resume_public_strategy');
  });
});

test('/api/marketing/jobs/:jobId/approve allows public approval when MARKETING_STATUS_PUBLIC is enabled', async () => {
  await withPublicMarketingEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    let runSeen = false;
    setOpenClawTestInvoker((payload) => {
      const args = ((payload.args as Record<string, unknown> | undefined) ?? {});
      const action = String(args.action || '');
      if (action === 'run') {
        runSeen = true;
        return {
          ok: true,
          status: 'needs_approval',
          output: [{ run_id: 'public-run-2' }],
          requiresApproval: { resumeToken: 'resume_public_strategy', prompt: 'Continue to strategy?' },
        };
      }
      if (action === 'resume') {
        return {
          ok: true,
          status: 'needs_approval',
          output: [{
            run_id: 'public-run-2',
            strategy_handoff: {
              run_id: 'public-run-2',
              core_message: 'Launch campaigns with operator control.',
              primary_cta: 'Book a walkthrough',
            },
          }],
          requiresApproval: { resumeToken: 'resume_public_production', prompt: 'Continue to production?' },
        };
      }
      throw new Error(`Unexpected action ${action}`);
    });

    const createResponse = await handlePostMarketingJobs(
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
      })
    );
    const created = (await createResponse.json()) as Record<string, unknown>;
    assert.equal(runSeen, true);

    const approveResponse = await handleApproveMarketingJob(
      String(created.jobId),
      new Request(`http://localhost/api/marketing/jobs/${String(created.jobId)}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          approvedBy: 'public-operator',
          approvedStages: ['strategy'],
        }),
      })
    );
    const approved = (await approveResponse.json()) as Record<string, unknown>;

    assert.equal(approveResponse.status, 200);
    assert.equal(approved.approval_status, 'resumed');
    const runtimeDoc = loadMarketingJobRuntime(String(created.jobId));
    assert.equal(runtimeDoc?.tenant_id, 'public_brand-example');
  });
});
