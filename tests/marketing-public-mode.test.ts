import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('/api/marketing/jobs/latest allows public read when MARKETING_STATUS_PUBLIC is enabled', async () => {
  await withPublicMarketingEnv(async () => {
    const { handleGetLatestMarketingJobStatus } = await import('../app/api/marketing/jobs/latest/handler');
    const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
    await rm(jobsRoot, { recursive: true, force: true });
    await mkdir(jobsRoot, { recursive: true });

    const updatedAt = '2026-04-05T00:00:00.000Z';
    await writeFile(
      path.join(jobsRoot, 'mkt_public_latest.json'),
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: 'mkt_public_latest',
        job_type: 'brand_campaign',
        tenant_id: 'public_brand-example',
        state: 'approval_required',
        status: 'awaiting_approval',
        current_stage: 'publish',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: {
            stage: 'publish',
            status: 'awaiting_approval',
            started_at: null,
            completed_at: null,
            failed_at: null,
            run_id: 'run-publish',
            summary: { summary: 'Approval needed', highlight: null },
            primary_output: null,
            outputs: {},
            artifacts: [],
            errors: [],
          },
        },
        approvals: {
          current: {
            stage: 'publish',
            status: 'awaiting_approval',
            title: 'Launch approval required',
            message: 'Approval needed before publish-ready assets are generated.',
            requested_at: updatedAt,
            resume_token: 'resume_publish',
            action_label: 'Approve launch',
            publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
          },
          history: [],
        },
        publish_config: { platforms: ['meta-ads'], live_publish_platforms: [], video_render_platforms: [] },
        brand_kit: {
          path: path.join(process.env.DATA_ROOT!, 'generated', 'validated', 'public_brand-example', 'brand-kit.json'),
          source_url: 'https://brand.example',
          canonical_url: 'https://brand.example',
          brand_name: 'Brand Example',
          logo_urls: [],
          colors: { primary: '#111111', secondary: '#f4f4f4', accent: '#c24d2c', palette: ['#111111', '#f4f4f4', '#c24d2c'] },
          font_families: ['Manrope'],
          external_links: [],
          extracted_at: '2026-03-18T00:00:00.000Z',
        },
        inputs: { request: {}, brand_url: 'https://brand.example' },
        errors: [],
        last_error: null,
        history: [],
        created_at: updatedAt,
        updated_at: updatedAt,
      }, null, 2),
    );

    let tenantLoaderCalls = 0;
    const response = await handleGetLatestMarketingJobStatus(async () => {
      tenantLoaderCalls += 1;
      throw new Error('Authentication required.');
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.jobId, 'mkt_public_latest');
    assert.equal(body.tenantName, 'Brand Example');
    assert.equal(tenantLoaderCalls, 0);
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

test('/api/business/profile preserves existing businessType, launchApproverName, and offer when PATCH receives empty values', async () => {
  await withPublicMarketingEnv(async () => {
    const { PATCH: patchBusinessProfileRoute } = await import('../app/api/business/profile/route');
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
          }),
        }),
      );

      const patchResponse = await patchBusinessProfileRoute(
        new Request('http://localhost/api/business/profile', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            websiteUrl: 'https://brand.example',
            businessType: '',
            launchApproverName: '   ',
            offer: '',
          }),
        }),
      );
      const patchedBody = (await patchResponse.json()) as { profile: Record<string, any> };
      const persistedPath = path.join(process.env.DATA_ROOT!, 'generated', 'validated', 'public_brand-example', 'business-profile.json');
      const persistedRecord = JSON.parse(await readFile(persistedPath, 'utf8')) as Record<string, any>;

      assert.equal(patchResponse.status, 200);
      assert.equal(patchedBody.profile.businessType, 'coaching');
      assert.equal(patchedBody.profile.launchApproverName, 'Avery Example');
      assert.equal(patchedBody.profile.offer, 'Operator-led launch intensives');
      assert.equal(persistedRecord.business_type, 'coaching');
      assert.equal(persistedRecord.launch_approver_name, 'Avery Example');
      assert.equal(persistedRecord.offer, 'Operator-led launch intensives');
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

test('/api/marketing/jobs persists present public onboarding fields and does not clobber them with empty follow-up payloads', async () => {
  await withPublicMarketingEnv(async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { loadMarketingJobRuntime } = await import('../backend/marketing/runtime-state');
    const restoreFetch = installPublicBrandSiteFetchMock();
    const businessProfilePath = path.join(
      process.env.DATA_ROOT!,
      'generated',
      'validated',
      'public_brand-example',
      'business-profile.json',
    );

    try {
      setOpenClawTestInvoker(() => ({
        ok: true,
        status: 'needs_approval',
        output: [{ run_id: 'public-run-persist' }],
        requiresApproval: { resumeToken: 'resume_public_persist', prompt: 'Continue to strategy?' },
      }));

      const firstCreateResponse = await handlePostMarketingJobs(
        new Request('http://localhost/api/marketing/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobType: 'brand_campaign',
            payload: {
              brandUrl: 'https://brand.example',
              businessType: 'coaching',
              goal: 'book more calls',
              approverName: 'Avery Example',
              offer: 'Operator-led launch intensives',
              competitorUrl: 'https://competitor.example',
              channels: ['meta-ads', 'instagram'],
            },
          }),
        }),
      );
      const firstCreated = (await firstCreateResponse.json()) as Record<string, unknown>;
      const firstRuntime = loadMarketingJobRuntime(String(firstCreated.jobId));
      const persistedAfterFirstCreate = JSON.parse(await readFile(businessProfilePath, 'utf8')) as Record<string, any>;

      assert.equal(firstCreateResponse.status, 202);
      assert.equal(persistedAfterFirstCreate.business_type, 'coaching');
      assert.equal(persistedAfterFirstCreate.primary_goal, 'book more calls');
      assert.equal(persistedAfterFirstCreate.launch_approver_name, 'Avery Example');
      assert.equal(persistedAfterFirstCreate.offer, 'Operator-led launch intensives');
      assert.equal(persistedAfterFirstCreate.competitor_url, 'https://competitor.example/');
      assert.deepEqual(persistedAfterFirstCreate.channels, ['meta-ads', 'instagram']);
      assert.equal(firstRuntime?.inputs.request.primaryGoal, 'book more calls');
      assert.equal(firstRuntime?.inputs.request.goal, 'book more calls');
      assert.equal(firstRuntime?.inputs.request.launchApproverName, 'Avery Example');
      assert.equal(firstRuntime?.inputs.request.approverName, 'Avery Example');

      const secondCreateResponse = await handlePostMarketingJobs(
        new Request('http://localhost/api/marketing/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobType: 'brand_campaign',
            payload: {
              brandUrl: 'https://brand.example',
              businessType: '',
              primaryGoal: '',
              launchApproverName: '',
              offer: '',
              competitorUrl: '',
              channels: [],
            },
          }),
        }),
      );
      const persistedAfterSecondCreate = JSON.parse(await readFile(businessProfilePath, 'utf8')) as Record<string, any>;

      assert.equal(secondCreateResponse.status, 202);
      assert.equal(persistedAfterSecondCreate.business_type, 'coaching');
      assert.equal(persistedAfterSecondCreate.primary_goal, 'book more calls');
      assert.equal(persistedAfterSecondCreate.launch_approver_name, 'Avery Example');
      assert.equal(persistedAfterSecondCreate.offer, 'Operator-led launch intensives');
      assert.equal(persistedAfterSecondCreate.competitor_url, 'https://competitor.example/');
      assert.deepEqual(persistedAfterSecondCreate.channels, ['meta-ads', 'instagram']);
    } finally {
      restoreFetch();
      clearOpenClawTestInvoker();
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
