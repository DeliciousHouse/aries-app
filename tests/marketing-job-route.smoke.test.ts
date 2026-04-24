import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installBrandExampleFetchMock } from './helpers/brand-example-fetch';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withMarketingRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousOpenClawLobsterCwd = process.env.OPENCLAW_LOBSTER_CWD;
  const previousGatewayLobsterCwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-route-'));
  const restoreFetch = installBrandExampleFetchMock();

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.OPENCLAW_LOBSTER_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = 'lobster';

  try {
    return await run(dataRoot);
  } finally {
    restoreFetch();
    delete (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__;
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousOpenClawLobsterCwd === undefined) delete process.env.OPENCLAW_LOBSTER_CWD;
    else process.env.OPENCLAW_LOBSTER_CWD = previousOpenClawLobsterCwd;
    if (previousGatewayLobsterCwd === undefined) delete process.env.OPENCLAW_GATEWAY_LOBSTER_CWD;
    else process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = previousGatewayLobsterCwd;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('/api/marketing/jobs reaches the first approval checkpoint through the real handler path', async () => {
  await withMarketingRuntimeEnv(async (dataRoot) => {
    const captured: Array<Record<string, unknown>> = [];
    (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ = (payload: Record<string, unknown>) => {
      captured.push(payload);
      return {
        ok: true,
        status: 'needs_approval',
        output: [{
          run_id: 'route-smoke-run',
          executive_summary: {
            market_positioning: 'Research is complete.',
            campaign_takeaway: 'Outcome-led creative is strongest.',
          },
        }],
        requiresApproval: {
          resumeToken: 'resume_strategy',
          prompt: 'Research complete. Approve strategy to continue.',
        },
      };
    };

    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');

    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/marketing/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'brand_campaign',
          payload: {
            brandUrl: 'https://brand.example/',
            competitorUrl: 'https://betterup.com/',
          },
        }),
      }),
      async () => ({
        userId: 'user-route-smoke',
        tenantId: 'tenant_route_smoke',
        tenantSlug: 'tenant-route-smoke',
        role: 'tenant_admin',
      }),
    );

    assert.equal(response.status, 202);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.marketing_job_status, 'accepted');
    assert.equal(body.approvalRequired, true);
    assert.equal(body.marketing_stage, 'strategy');
    assert.equal(typeof body.jobId, 'string');
    assert.equal((captured[0]?.args as Record<string, unknown>)?.pipeline, 'marketing-pipeline.lobster');
    assert.equal((captured[0]?.args as Record<string, unknown>)?.cwd, 'lobster');

    const runtimeDoc = await loadMarketingJobRuntime(String(body.jobId));
    assert.equal(runtimeDoc?.current_stage, 'strategy');
    assert.equal(runtimeDoc?.stages.research.run_id, 'route-smoke-run');
    assert.equal(runtimeDoc?.approvals.current?.workflow_step_id, 'approve_stage_2');

    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${String(body.jobId)}.json`);
    const persisted = JSON.parse(await readFile(runtimeFile, 'utf8')) as Record<string, any>;
    assert.equal(persisted.current_stage, 'strategy');
    assert.equal(persisted.approvals.current?.workflow_step_id, 'approve_stage_2');
  });
});
