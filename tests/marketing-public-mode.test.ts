import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';

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

function createFetchResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
    },
  });
}

function installPublicBrandSiteFetchMock(): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url === 'https://brand.example/' || url === 'https://brand.example') {
      return createFetchResponse(
        `<!doctype html>
        <html>
          <head>
            <title>Brand Example</title>
            <meta property="og:site_name" content="Brand Example" />
            <meta name="description" content="Brand Example helps teams launch proof-led campaigns." />
            <meta name="theme-color" content="#111111" />
            <link rel="canonical" href="https://brand.example/" />
            <link rel="icon" href="/assets/logo.svg" />
            <link rel="stylesheet" href="/assets/site.css" />
          </head>
          <body>
            <h1>Brand Example</h1>
            <a href="https://instagram.com/brandexample">Join now</a>
            <img src="/assets/wordmark.png" alt="Brand Example wordmark" />
          </body>
        </html>`,
        'text/html; charset=utf-8',
      );
    }

    if (url === 'https://brand.example/assets/site.css') {
      return createFetchResponse(
        `:root { --brand-primary: #111111; --brand-secondary: #f4f4f4; --brand-accent: #c24d2c; }
         body { font-family: "Manrope", sans-serif; color: #111111; background: #f4f4f4; }`,
        'text/css; charset=utf-8',
      );
    }

    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
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
    const restoreFetch = installPublicBrandSiteFetchMock();
    try {
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
    } finally {
      restoreFetch();
    }
  });
});

test('/api/marketing/jobs/:jobId/approve allows public approval when MARKETING_STATUS_PUBLIC is enabled', async () => {
  await withPublicMarketingEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { handleApproveMarketingJob } = await import('../app/api/marketing/jobs/[jobId]/approve/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const restoreFetch = installPublicBrandSiteFetchMock();
    try {
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
    } finally {
      restoreFetch();
    }
  });
});

test('/api/business/profile persists public onboarding fields file-backed and hydrates brandKit from extracted data', async () => {
  await withPublicMarketingEnv(async () => {
    const { GET: getBusinessProfileRoute, PATCH: patchBusinessProfileRoute } = await import('../app/api/business/profile/route');
    const restoreFetch = installPublicBrandSiteFetchMock();

    try {
      const patchResponse = await patchBusinessProfileRoute(
        new Request('http://localhost/api/business/profile', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            businessName: 'Brand Example LLC',
            websiteUrl: 'https://brand.example',
            businessType: 'coaching',
            primaryGoal: 'book more calls',
            launchApproverName: 'Avery Example',
            offer: 'Operator-led launch intensives',
            notes: 'Focus on proof-led messaging.',
            competitorUrl: 'https://competitor.example',
            channels: ['meta-ads', 'instagram'],
          }),
        }),
      );
      const patchedBody = (await patchResponse.json()) as { profile: Record<string, any> };
      const persistedPath = path.join(process.env.DATA_ROOT!, 'generated', 'validated', 'public_brand-example', 'business-profile.json');
      const persistedRecord = JSON.parse(await readFile(persistedPath, 'utf8')) as Record<string, any>;

      assert.equal(patchResponse.status, 200);
      assert.equal(patchedBody.profile.tenantId, 'public_brand-example');
      assert.equal(patchedBody.profile.businessName, 'Brand Example LLC');
      assert.equal(patchedBody.profile.websiteUrl, 'https://brand.example/');
      assert.equal(patchedBody.profile.businessType, 'coaching');
      assert.equal(patchedBody.profile.primaryGoal, 'book more calls');
      assert.equal(patchedBody.profile.launchApproverName, 'Avery Example');
      assert.equal(patchedBody.profile.offer, 'Operator-led launch intensives');
      assert.equal(patchedBody.profile.notes, 'Focus on proof-led messaging.');
      assert.equal(patchedBody.profile.competitorUrl, 'https://competitor.example/');
      assert.deepEqual(patchedBody.profile.channels, ['meta-ads', 'instagram']);
      assert.equal(persistedRecord.tenant_id, 'public_brand-example');
      assert.equal(persistedRecord.website_url, 'https://brand.example/');
      assert.equal(persistedRecord.launch_approver_name, 'Avery Example');
      assert.equal(persistedRecord.offer, 'Operator-led launch intensives');
      assert.equal(persistedRecord.competitor_url, 'https://competitor.example/');
      assert.deepEqual(persistedRecord.channels, ['meta-ads', 'instagram']);

      const getResponse = await getBusinessProfileRoute(
        new Request('http://localhost/api/business/profile?websiteUrl=https%3A%2F%2Fbrand.example'),
      );
      const getBody = (await getResponse.json()) as { profile: Record<string, any> };

      assert.equal(getResponse.status, 200);
      assert.equal(getBody.profile.businessName, 'Brand Example LLC');
      assert.equal(getBody.profile.brandKit.brand_name, 'Brand Example');
      assert.equal(getBody.profile.brandKit.source_url, 'https://brand.example/');
      assert.equal(getBody.profile.brandKit.colors.primary, '#111111');
      assert.deepEqual(getBody.profile.channels, ['meta-ads', 'instagram']);
    } finally {
      restoreFetch();
    }
  });
});

test('/api/marketing/jobs backfills missing onboarding fields from the persisted business profile into runtime and workspace state', async () => {
  await withPublicMarketingEnv(async () => {
    const { GET: getBusinessProfileRoute, PATCH: patchBusinessProfileRoute } = await import('../app/api/business/profile/route');
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const { loadCampaignWorkspaceRecord } = await import('../backend/marketing/workspace-store');
    const restoreFetch = installPublicBrandSiteFetchMock();

    try {
      await patchBusinessProfileRoute(
        new Request('http://localhost/api/business/profile', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            businessName: 'Brand Example LLC',
            websiteUrl: 'https://brand.example',
            businessType: 'coaching',
            primaryGoal: 'book more calls',
            launchApproverName: 'Avery Example',
            offer: 'Operator-led launch intensives',
            competitorUrl: 'https://competitor.example',
            channels: ['meta-ads', 'instagram'],
          }),
        }),
      );

      setOpenClawTestInvoker(() => ({
        ok: true,
        status: 'needs_approval',
        output: [{ run_id: 'public-run-backfill' }],
        requiresApproval: { resumeToken: 'resume_public_strategy', prompt: 'Continue to strategy?' },
      }));

      const createResponse = await handlePostMarketingJobs(
        new Request('http://localhost/api/marketing/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobType: 'brand_campaign',
            payload: {
              brandUrl: 'https://brand.example',
            },
          }),
        }),
      );
      const created = (await createResponse.json()) as Record<string, unknown>;
      const jobId = String(created.jobId);
      const runtimeDoc = loadMarketingJobRuntime(jobId);
      const workspace = loadCampaignWorkspaceRecord(jobId, 'public_brand-example');

      const getResponse = await getBusinessProfileRoute(
        new Request('http://localhost/api/business/profile?websiteUrl=https%3A%2F%2Fbrand.example'),
      );
      const getBody = (await getResponse.json()) as { profile: Record<string, any> };

      assert.equal(createResponse.status, 202);
      assert.equal(runtimeDoc?.tenant_id, 'public_brand-example');
      assert.equal(runtimeDoc?.inputs.request.businessType, 'coaching');
      assert.equal(runtimeDoc?.inputs.request.primaryGoal, 'book more calls');
      assert.equal(runtimeDoc?.inputs.request.goal, 'book more calls');
      assert.equal(runtimeDoc?.inputs.request.launchApproverName, 'Avery Example');
      assert.equal(runtimeDoc?.inputs.request.approverName, 'Avery Example');
      assert.equal(runtimeDoc?.inputs.request.offer, 'Operator-led launch intensives');
      assert.equal(runtimeDoc?.inputs.request.competitorUrl, 'https://competitor.example/');
      assert.deepEqual(runtimeDoc?.inputs.request.channels, ['meta-ads', 'instagram']);
      assert.equal(workspace?.brief.businessType, 'coaching');
      assert.equal(workspace?.brief.goal, 'book more calls');
      assert.equal(workspace?.brief.approverName, 'Avery Example');
      assert.equal(workspace?.brief.offer, 'Operator-led launch intensives');
      assert.equal(workspace?.brief.competitorUrl, 'https://competitor.example/');
      assert.deepEqual(workspace?.brief.channels, ['meta-ads', 'instagram']);
      assert.equal(getResponse.status, 200);
      assert.equal(getBody.profile.businessType, 'coaching');
      assert.equal(getBody.profile.primaryGoal, 'book more calls');
      assert.equal(getBody.profile.launchApproverName, 'Avery Example');
      assert.equal(getBody.profile.offer, 'Operator-led launch intensives');
      assert.equal(getBody.profile.competitorUrl, 'https://competitor.example/');
      assert.deepEqual(getBody.profile.channels, ['meta-ads', 'instagram']);
    } finally {
      restoreFetch();
    }
  });
});

test('/api/pipeline/url-preview returns only real extracted brand data in public mode', async () => {
  await withPublicMarketingEnv(async () => {
    const { GET: getUrlPreview } = await import('../app/api/pipeline/url-preview/route');
    const restoreFetch = installPublicBrandSiteFetchMock();

    try {
      const response = await getUrlPreview(
        new NextRequest('http://localhost/api/pipeline/url-preview?url=https%3A%2F%2Fbrand.example'),
      );
      const body = (await response.json()) as Record<string, any>;
      const serialized = JSON.stringify(body);

      assert.equal(response.status, 200);
      assert.equal(body.title, 'Brand Example');
      assert.equal(body.domain, 'brand.example');
      assert.equal(body.canonicalUrl, 'https://brand.example/');
      assert.equal(body.brandKitPreview.brandName, 'Brand Example');
      assert.equal(body.brandKitPreview.logoUrls.includes('https://brand.example/assets/wordmark.png'), true);
      assert.equal(body.brandKitPreview.colors.primary, '#111111');
      assert.deepEqual(body.brandKitPreview.fontFamilies, ['Manrope']);
      assert.equal(typeof body.brandKitPreview.brandVoiceSummary, 'string');
      assert.equal(body.brandKitPreview.offerSummary, null);
      assert.doesNotMatch(serialized, /ideal customer/i);
      assert.doesNotMatch(serialized, /premium feel/i);
      assert.doesNotMatch(serialized, /placeholder/i);
    } finally {
      restoreFetch();
    }
  });
});
