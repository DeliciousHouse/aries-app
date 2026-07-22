import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installBrandExampleFetchMock } from './helpers/brand-example-fetch';
import { resolveProjectRoot } from './helpers/project-root';
import { oauthStore } from '../backend/integrations/oauth-memory-store';
import pool from '../lib/db';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

// Pre-seeds a brand-kit.json for the given tenant so extractAndSaveTenantBrandKit
// takes the fast cache path and never issues a DNS lookup for brand.example.
async function seedBrandKitForTenant(dataRoot: string, tenantId: string): Promise<void> {
  const kitDir = path.join(dataRoot, 'generated', 'validated', tenantId);
  await mkdir(kitDir, { recursive: true });
  await writeFile(
    path.join(kitDir, 'brand-kit.json'),
    JSON.stringify({
      tenant_id: tenantId,
      source_url: 'https://brand.example/',
      canonical_url: 'https://brand.example/',
      brand_name: 'Brand Example',
      logo_urls: ['https://brand.example/assets/logo.svg'],
      colors: {
        primary: '#111111',
        secondary: '#f4f4f4',
        accent: '#c24d2c',
        palette: ['#111111', '#f4f4f4', '#c24d2c'],
      },
      font_families: ['Manrope'],
      external_links: [],
      extracted_at: new Date().toISOString(),
      brand_voice_summary: 'Brand Example helps teams launch proof-led campaigns.',
      offer_summary: null,
      positioning: 'proof-led',
      audience: 'marketing teams',
      tone_of_voice: 'professional',
      style_vibe: 'minimal',
    }, null, 2),
  );
}

async function withMarketingRuntimeEnv<T>(
  tenantId: string,
  run: (dataRoot: string) => Promise<T>,
): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousPipelineCwd = process.env.ARTIFACT_PIPELINE_CWD;
  const previousPipelineGatewayCwd = process.env.ARTIFACT_PIPELINE_GATEWAY_CWD;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-marketing-route-'));
  const restoreFetch = installBrandExampleFetchMock();
  const store = oauthStore();
  store.pendingByState.clear();
  store.connectionsById.clear();
  store.connectedByTenantProvider.clear();

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  process.env.ARTIFACT_PIPELINE_CWD = path.join(PROJECT_ROOT, 'lobster');
  process.env.ARTIFACT_PIPELINE_GATEWAY_CWD = 'lobster';

  // Pre-seed brand kit so the orchestrator path never makes a live DNS request
  // for brand.example (which resolves to nothing in the test environment).
  await seedBrandKitForTenant(dataRoot, tenantId);

  try {
    return await run(dataRoot);
  } finally {
    restoreFetch();
    delete (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__;
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousPipelineCwd === undefined) delete process.env.ARTIFACT_PIPELINE_CWD;
    else process.env.ARTIFACT_PIPELINE_CWD = previousPipelineCwd;
    if (previousPipelineGatewayCwd === undefined) delete process.env.ARTIFACT_PIPELINE_GATEWAY_CWD;
    else process.env.ARTIFACT_PIPELINE_GATEWAY_CWD = previousPipelineGatewayCwd;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function seedOpenAiConnection(input: { tenantId: string; connectionId: string; updatedAt: string; tokenExpiresAt?: string }) {
  const store = oauthStore();
  store.connectionsById.set(input.connectionId, {
    connection_id: input.connectionId,
    provider: 'openai',
    tenant_id: input.tenantId,
    connection_status: 'connected',
    granted_scopes: ['openid', 'profile'],
    created_at: input.updatedAt,
    updated_at: input.updatedAt,
    token_expires_at: input.tokenExpiresAt,
  });
  store.connectedByTenantProvider.set(`${input.tenantId}::openai`, input.connectionId);
}

test('/api/marketing/jobs reaches the first approval checkpoint through the real handler path', async () => {
  await withMarketingRuntimeEnv('tenant_route_smoke', async (dataRoot) => {
    const captured: Array<Record<string, unknown>> = [];
    (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__ = (payload: Record<string, unknown>) => {
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
    const { loadSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');

    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/marketing/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
            businessType: 'Test vertical',
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
    assert.equal(typeof body.approvalRequired, 'boolean');
    assert.equal(body.marketing_stage, 'research');
    assert.equal(typeof body.jobId, 'string');
    const runtimeDoc = await loadSocialContentJobRuntime(String(body.jobId));
    assert.equal(runtimeDoc?.current_stage, 'research');
    assert.equal(typeof runtimeDoc?.stages.research, 'object');

    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${String(body.jobId)}.json`);
    const persisted = JSON.parse(await readFile(runtimeFile, 'utf8')) as Record<string, any>;
    assert.equal(persisted.current_stage, 'research');
    assert.equal(typeof persisted.approvals, 'object');
  });
});

test('/api/social-content/jobs accepts weekly_social_content and returns 202', async () => {
  await withMarketingRuntimeEnv('tenant_social_route', async () => {
    seedOpenAiConnection({
      tenantId: 'tenant_social_route',
      connectionId: 'conn_openai_social_route',
      updatedAt: '2026-05-05T00:00:00.000Z',
      tokenExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
    (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__ = () => ({
      ok: true,
      status: 'needs_approval',
      output: [
        {
          run_id: 'social-route-run',
          executive_summary: {
            market_positioning: 'Research complete.',
            campaign_takeaway: 'Plan ready.',
          },
        },
      ],
      requiresApproval: {
        resumeToken: 'resume_strategy',
        prompt: 'Research complete. Approve strategy to continue.',
      },
    });

    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/social-content/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
            businessType: 'Test vertical',
            primaryGoal: 'Book demos',
          },
        }),
      }),
      async () => ({
        userId: 'user-social-route',
        tenantId: 'tenant_social_route',
        tenantSlug: 'tenant-social-route',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );

    assert.equal(response.status, 202);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.social_content_job_status, 'accepted');
    assert.equal(body.jobType, 'weekly_social_content');
    assert.equal(typeof body.jobStatusUrl, 'string');
    assert.match(String(body.jobStatusUrl), /^\/social-content\/status\?jobId=/);
  });
});

test('/api/social-content/jobs waits for explicit PostgreSQL provenance, invalidates inferred goal cache, and refreshes Insights', async (t) => {
  const tenantId = '42001';
  await withMarketingRuntimeEnv(tenantId, async (dataRoot) => {
    seedOpenAiConnection({
      tenantId,
      connectionId: 'conn_openai_social_route_human_goal',
      updatedAt: '2026-05-05T00:00:00.000Z',
      tokenExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });

    const profilePath = path.join(
      dataRoot,
      'generated',
      'validated',
      tenantId,
      'business-profile.json',
    );
    await writeFile(profilePath, JSON.stringify({
      tenant_id: tenantId,
      business_name: 'Brand Example',
      tenant_slug: 'brand-example',
      website_url: 'https://brand.example/',
      business_type: 'Test vertical',
      primary_goal: 'Increase social media presence',
      primary_goal_source: 'inferred',
      channels: [],
    }));

    let databaseProfile = {
      primary_goal: 'Increase social media presence',
      primary_goal_source: 'inferred' as 'explicit' | 'inferred',
    };
    let goalCache: {
      body: Record<string, unknown>;
      generated_at: Date;
      model: string;
    } | null = {
      body: {
        goal: 'brand_awareness',
        goalLabel: 'Brand Awareness',
        goalInferred: true,
      },
      generated_at: new Date(),
      model: 'goal-template-v8',
    };
    const events: string[] = [];
    let releaseUpsert!: () => void;
    const upsertGate = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    let markUpsertStarted!: () => void;
    const upsertStarted = new Promise<void>((resolve) => {
      markUpsertStarted = resolve;
    });

    const query = async (sqlInput: string, params: unknown[] = []) => {
      const sql = String(sqlInput);
      if (sql.includes('INSERT INTO business_profiles')) {
        events.push('profile-upsert-started');
        markUpsertStarted();
        await upsertGate;
        databaseProfile = {
          primary_goal: String(params[5]),
          primary_goal_source: params[6] as 'explicit' | 'inferred',
        };
        events.push('profile-upserted');
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('DELETE FROM insights_narratives')) {
        assert.deepEqual(params, [Number(tenantId)]);
        goalCache = null;
        events.push('goal-cache-invalidated');
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SELECT body, generated_at, model')) {
        return { rowCount: goalCache ? 1 : 0, rows: goalCache ? [goalCache] : [] };
      }
      if (sql.includes('SELECT timezone FROM business_profiles')) {
        return { rowCount: 1, rows: [{ timezone: 'UTC' }] };
      }
      if (sql.includes('SELECT primary_goal, primary_goal_source')) {
        return { rowCount: 1, rows: [databaseProfile] };
      }
      if (sql.includes('insights_account_metrics_daily') && sql.includes('AS reach')) {
        return { rowCount: 1, rows: [{ reach: '0' }] };
      }
      if (sql.includes('FROM insights_posts')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO insights_narratives')) {
        goalCache = {
          body: JSON.parse(String(params[3])) as Record<string, unknown>,
          generated_at: new Date(),
          model: String(params[5]),
        };
        events.push('goal-cache-refreshed');
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    };

    t.mock.method(pool, 'query', query as unknown as typeof pool.query);
    t.mock.method(pool, 'connect', (async () => ({
      query,
      release() {},
    })) as unknown as typeof pool.connect);

    (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__ = () => ({
      ok: true,
      status: 'needs_approval',
      output: [{
        run_id: 'social-route-human-goal',
        executive_summary: {
          market_positioning: 'Research is complete.',
          campaign_takeaway: 'Plan ready.',
        },
      }],
      requiresApproval: {
        resumeToken: 'resume_strategy',
        prompt: 'Research complete. Approve strategy to continue.',
      },
    });

    const formData = new FormData();
    formData.set('jobType', 'weekly_social_content');
    formData.set('websiteUrl', 'https://brand.example/');
    formData.set('businessType', 'Test vertical');
    formData.set('primaryGoal', 'Increase social media presence');
    formData.set('goal', 'Increase social media presence');

    const { handlePostSocialContentJobs } = await import('../app/api/social-content/jobs/route');
    const responsePromise = handlePostSocialContentJobs(
      new Request('http://aries.example.test/api/social-content/jobs', {
        method: 'POST',
        body: formData,
      }),
      async () => ({
        userId: 'user-social-route-human-goal',
        tenantId,
        tenantSlug: 'brand-example',
        role: 'tenant_admin',
      }),
    );

    await upsertStarted;
    const beforeRelease = await Promise.race([
      responsePromise.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    assert.equal(beforeRelease, 'pending', 'the request must remain pending until PostgreSQL commits');
    assert.deepEqual(events, ['profile-upsert-started']);
    assert.equal(goalCache?.body.goalInferred, true, 'cache must not invalidate before persistence succeeds');

    releaseUpsert();
    const response = await responsePromise;
    assert.equal(response.status, 202);
    assert.deepEqual(events, [
      'profile-upsert-started',
      'profile-upserted',
      'goal-cache-invalidated',
    ]);
    assert.equal(databaseProfile.primary_goal_source, 'explicit');
    assert.equal(goalCache, null);

    const stored = JSON.parse(await readFile(profilePath, 'utf8')) as Record<string, unknown>;
    assert.equal(stored.primary_goal, 'Increase social media presence');
    assert.equal(stored.primary_goal_source, 'explicit');

    const { handleGetInsightsGoal } = await import('../backend/insights/goal/handler');
    const insightsResponse = await handleGetInsightsGoal(
      new Request('http://aries.example.test/api/insights/goal?period=week&platform=all'),
      async () => ({
        userId: 'user-social-route-human-goal',
        tenantId,
        tenantSlug: 'brand-example',
        role: 'tenant_admin',
      }),
    );
    const insightsBody = await insightsResponse.json() as Record<string, unknown>;

    assert.equal(insightsResponse.status, 200);
    assert.equal(insightsBody.cached, false, 'the stale inferred goal narrative must not survive');
    assert.equal(insightsBody.goalInferred, false, 'Insights must render the operator-confirmed goal immediately');
    const refreshedGoalCache = goalCache as unknown as {
      body: Record<string, unknown>;
    } | null;
    assert.ok(refreshedGoalCache);
    assert.equal(refreshedGoalCache.body.goalInferred, false);
    assert.deepEqual(events, [
      'profile-upsert-started',
      'profile-upserted',
      'goal-cache-invalidated',
      'goal-cache-refreshed',
    ]);
  });
});

test('/api/social-content/jobs fails closed when explicit PostgreSQL provenance cannot persist', async (t) => {
  const tenantId = '42002';
  await withMarketingRuntimeEnv(tenantId, async (dataRoot) => {
    seedOpenAiConnection({
      tenantId,
      connectionId: 'conn_openai_social_route_goal_failure',
      updatedAt: '2026-05-05T00:00:00.000Z',
      tokenExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
    const profilePath = path.join(
      dataRoot,
      'generated',
      'validated',
      tenantId,
      'business-profile.json',
    );
    await writeFile(profilePath, JSON.stringify({
      tenant_id: tenantId,
      primary_goal: 'Increase social media presence',
      primary_goal_source: 'inferred',
      channels: [],
    }));

    const events: string[] = [];
    t.mock.method(pool, 'query', (async (sqlInput: string) => {
      const sql = String(sqlInput);
      if (sql.includes('INSERT INTO business_profiles')) {
        events.push('profile-upsert-failed');
        throw new Error('simulated explicit provenance failure');
      }
      if (sql.includes('DELETE FROM insights_narratives')) {
        events.push('goal-cache-invalidated');
      }
      return { rowCount: 0, rows: [] };
    }) as unknown as typeof pool.query);

    let executionCalls = 0;
    (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__ = () => {
      executionCalls += 1;
      return {
        ok: true,
        status: 'needs_approval',
        output: [{ run_id: 'must-not-queue' }],
        requiresApproval: {
          resumeToken: 'must-not-exist',
          prompt: 'must not queue',
        },
      };
    };

    const formData = new FormData();
    formData.set('jobType', 'weekly_social_content');
    formData.set('websiteUrl', 'https://brand.example/');
    formData.set('businessType', 'Test vertical');
    formData.set('primaryGoal', 'Increase social media presence');

    const { handlePostSocialContentJobs } = await import('../app/api/social-content/jobs/route');
    const response = await handlePostSocialContentJobs(
      new Request('http://aries.example.test/api/social-content/jobs', {
        method: 'POST',
        body: formData,
      }),
      async () => ({
        userId: 'user-social-route-goal-failure',
        tenantId,
        tenantSlug: 'brand-example',
        role: 'tenant_admin',
      }),
    );

    assert.notEqual(response.status, 202, 'a failed explicit upsert must not report a queued job');
    assert.equal(executionCalls, 0, 'Hermes execution must not start with stale PostgreSQL provenance');
    assert.deepEqual(events, ['profile-upsert-failed'], 'cache invalidation must not run after a failed upsert');
    const stored = JSON.parse(await readFile(profilePath, 'utf8')) as Record<string, unknown>;
    assert.equal(stored.primary_goal_source, 'inferred');
  });
});

test('/api/social-content/jobs forces weekly_social_content even when caller sends another jobType', async () => {
  await withMarketingRuntimeEnv('tenant_social_route_forced_weekly', async () => {
    seedOpenAiConnection({
      tenantId: 'tenant_social_route_forced_weekly',
      connectionId: 'conn_openai_social_route_forced_weekly',
      updatedAt: '2026-05-05T00:00:00.000Z',
      tokenExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
    (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__ = () => ({
      ok: true,
      status: 'needs_approval',
      output: [
        {
          run_id: 'social-route-forced-weekly',
          executive_summary: {
            market_positioning: 'Research complete.',
            campaign_takeaway: 'Plan ready.',
          },
        },
      ],
      requiresApproval: {
        resumeToken: 'resume_strategy',
        prompt: 'Research complete. Approve strategy to continue.',
      },
    });

    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/social-content/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
            businessType: 'Test vertical',
            primaryGoal: 'Book demos',
          },
        }),
      }),
      async () => ({
        userId: 'user-social-route-forced-weekly',
        tenantId: 'tenant_social_route_forced_weekly',
        tenantSlug: 'tenant-social-route-forced-weekly',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );

    assert.equal(response.status, 202);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.social_content_job_status, 'accepted');
    assert.equal(body.jobType, 'weekly_social_content');
  });
});

test('/api/social-content/jobs submits Hermes only even when legacy-openclaw is selected', async () => {
  await withMarketingRuntimeEnv('tenant_social_route_hermes_only', async () => {
    const previousFetch = globalThis.fetch;
    const previousEnv = {
      ARIES_MARKETING_EXECUTION_PROVIDER: process.env.ARIES_MARKETING_EXECUTION_PROVIDER,
      HERMES_GATEWAY_URL: process.env.HERMES_GATEWAY_URL,
      HERMES_API_SERVER_KEY: process.env.HERMES_API_SERVER_KEY,
      HERMES_SESSION_KEY: process.env.HERMES_SESSION_KEY,
      HERMES_SYNC_POLL_FOR_TESTS: process.env.HERMES_SYNC_POLL_FOR_TESTS,
      INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET,
      APP_BASE_URL: process.env.APP_BASE_URL,
    };
    const hermesCalls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

    seedOpenAiConnection({
      tenantId: 'tenant_social_route_hermes_only',
      connectionId: 'conn_openai_social_route_hermes_only',
      updatedAt: '2026-05-05T00:00:00.000Z',
      tokenExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
    (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__ = () => {
      throw new Error('social-content route must not call legacy OpenClaw');
    };

    process.env.ARIES_MARKETING_EXECUTION_PROVIDER = 'legacy-openclaw';
    process.env.HERMES_GATEWAY_URL = 'https://hermes.example.com';
    process.env.HERMES_API_SERVER_KEY = 'hermes-api-key';
    process.env.HERMES_POLL_BRIDGE_ENABLED = '0';
    process.env.HERMES_SESSION_KEY = 'weekly-social-content-test';
    process.env.INTERNAL_API_SECRET = 'internal-secret';
    process.env.APP_BASE_URL = 'https://aries.example.com';
    delete process.env.HERMES_SYNC_POLL_FOR_TESTS;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.startsWith('https://hermes.example.com/v1/runs')) {
        hermesCalls.push({
          url,
          method,
          body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
        });
        if (method === 'POST' && url === 'https://hermes.example.com/v1/runs') {
          return new Response(JSON.stringify({ run_id: 'hermes-social-route-1', status: 'started' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'unexpected Hermes polling request' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }

      return previousFetch(input, init);
    }) as typeof fetch;

    try {
      const { handlePostSocialContentJobs } = await import('../app/api/social-content/jobs/route');
      const response = await handlePostSocialContentJobs(
        new Request('http://aries.example.test/api/social-content/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            payload: {
              brandUrl: 'https://brand.example/',
              businessType: 'Test vertical',
              primaryGoal: 'Book demos',
              imageCreativeCount: 1,
            },
          }),
        }),
        async () => ({
          userId: 'user-social-route-hermes-only',
          tenantId: 'tenant_social_route_hermes_only',
          tenantSlug: 'tenant-social-route-hermes-only',
          role: 'tenant_admin',
        }),
      );

      assert.equal(response.status, 202);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.social_content_job_status, 'accepted');
      assert.equal(body.jobType, 'weekly_social_content');

      assert.equal(hermesCalls.length, 1);
      assert.equal(hermesCalls[0].url, 'https://hermes.example.com/v1/runs');
      assert.equal(hermesCalls[0].method, 'POST');
      assert.equal(hermesCalls.some((call) => call.method === 'GET'), false);
      // Workflow key + version are now in the serialized prompt + callback_context
      // (Hermes /v1/runs requires `input` to be a string, not a structured object).
      const submission = hermesCalls[0].body as Record<string, unknown>;
      const callbackContext = submission.callback_context as Record<string, unknown>;
      assert.equal(callbackContext.workflow_key, 'social_content_weekly');
      assert.equal(callbackContext.workflow_version, '2026-05-social-content-weekly-v2');
      assert.equal(typeof submission.input, 'string');
      assert.match(String(submission.input), /Workflow: social_content_weekly/);
    } finally {
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

test('/api/marketing/jobs remains backward-compatible alias with weekly_social_content', async () => {
  await withMarketingRuntimeEnv('tenant_marketing_alias', async () => {
    seedOpenAiConnection({
      tenantId: 'tenant_marketing_alias',
      connectionId: 'conn_openai_marketing_alias',
      updatedAt: '2026-05-05T00:00:00.000Z',
      tokenExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
    (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__ = () => ({
      ok: true,
      status: 'needs_approval',
      output: [
        {
          run_id: 'marketing-alias-run',
          executive_summary: {
            market_positioning: 'Research complete.',
            campaign_takeaway: 'Plan ready.',
          },
        },
      ],
      requiresApproval: {
        resumeToken: 'resume_strategy',
        prompt: 'Research complete. Approve strategy to continue.',
      },
    });

    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/marketing/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
            businessType: 'Test vertical',
            primaryGoal: 'Book demos',
          },
        }),
      }),
      async () => ({
        userId: 'user-marketing-alias',
        tenantId: 'tenant_marketing_alias',
        tenantSlug: 'tenant-marketing-alias',
        role: 'tenant_admin',
      }),
    );

    assert.equal(response.status, 202);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.marketing_job_status, 'accepted');
    assert.equal(typeof body.jobId, 'string');
  });
});

test('/api/social-content/jobs accepts media generation without Aries-side OpenAI connection state', async () => {
  await withMarketingRuntimeEnv('tenant_social_route_missing_openai', async () => {
    let invoked = false;
    (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__ = () => {
      invoked = true;
      return {
        ok: true,
        status: 'needs_approval',
        output: [],
        requiresApproval: null,
      };
    };

    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/social-content/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
            businessType: 'Test vertical',
            primaryGoal: 'Book demos',
            imageCreativeCount: 2,
            videoRenderCount: 1,
          },
        }),
      }),
      async () => ({
        userId: 'user-social-route-missing-openai',
        tenantId: 'tenant_social_route_missing_openai',
        tenantSlug: 'tenant-social-route-missing-openai',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );

    assert.equal(response.status, 202);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.social_content_job_status, 'accepted');
    assert.equal(body.reason, undefined);
    assert.equal(body.message, undefined);
    assert.equal(invoked, false);
  });
});

test('/api/social-content/jobs strips token-shaped payload fields from runtime and status JSON', async () => {
  await withMarketingRuntimeEnv('tenant_social_route_token_safety', async (dataRoot) => {
    const secretValues = [
      'sk-openai-runtime-leak',
      'raw-access-token-leak',
      'raw-refresh-token-leak',
      'raw-id-token-leak',
      'client-secret-leak',
      'api-key-leak',
      'bearer-auth-leak',
      'sk-primary-goal-runtime-leak',
      'offer-runtime-leak',
      'notes-runtime-leak',
      'creative-runtime-leak',
      'visual-runtime-leak',
    ];
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/social-content/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
            businessType: 'Test vertical',
            primaryGoal: secretValues[7],
            offer: `client_secret=${secretValues[8]}`,
            notes: `Bearer ${secretValues[9]}`,
            imageCreativeCount: 2,
            openaiAccessToken: secretValues[0],
            access_token: secretValues[1],
            creativeBriefs: [
              `Image concept api_key=${secretValues[10]}`,
              'Safe ordinary creative brief',
            ],
            visualReferences: [
              `https://assets.example/image.png?access_token=${secretValues[11]}&width=1024`,
            ],
            nested: {
              refresh_token: secretValues[2],
              id_token: secretValues[3],
              connection_id: 'conn_reference_is_not_secret',
            },
            credentials: [
              {
                client_secret: secretValues[4],
                api_key: secretValues[5],
                authorization: secretValues[6],
                userId: 'user-reference-is-not-secret',
              },
            ],
          },
        }),
      }),
      async () => ({
        userId: 'user-social-route-token-safety',
        tenantId: 'tenant_social_route_token_safety',
        tenantSlug: 'tenant-social-route-token-safety',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );

    assert.equal(response.status, 202);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.social_content_job_status, 'accepted');

    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${String(body.jobId)}.json`);
    const runtimeJson = await readFile(runtimeFile, 'utf8');
    const statusResponse = await handleGetMarketingJobStatus(
      String(body.jobId),
      async () => ({
        userId: 'user-social-route-token-safety',
        tenantId: 'tenant_social_route_token_safety',
        tenantSlug: 'tenant-social-route-token-safety',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );
    const statusJson = JSON.stringify(await statusResponse.json());

    for (const secretValue of secretValues) {
      assert.equal(runtimeJson.includes(secretValue), false);
      assert.equal(statusJson.includes(secretValue), false);
    }
    assert.equal(runtimeJson.includes('conn_reference_is_not_secret'), true);
    assert.equal(runtimeJson.includes('user-reference-is-not-secret'), true);
    assert.equal(runtimeJson.includes('Safe ordinary creative brief'), true);
  });
});

test('/api/social-content/jobs ignores expired Aries OpenAI connections for Hermes-owned media generation', async () => {
  await withMarketingRuntimeEnv('tenant_social_route_expired_openai', async (dataRoot) => {
    seedOpenAiConnection({
      tenantId: 'tenant_social_route_expired_openai',
      connectionId: 'conn_expired_openai',
      updatedAt: '2026-05-05T00:00:00.000Z',
      tokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    let invoked = false;
    (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__ = () => {
      invoked = true;
      return {
        ok: true,
        status: 'needs_approval',
        output: [],
        requiresApproval: null,
      };
    };

    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/social-content/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
            businessType: 'Test vertical',
            primaryGoal: 'Book demos',
            imageCreativeCount: 1,
          },
        }),
      }),
      async () => ({
        userId: 'user-social-route-expired-openai',
        tenantId: 'tenant_social_route_expired_openai',
        tenantSlug: 'tenant-social-route-expired-openai',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );

    assert.equal(response.status, 202);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.social_content_job_status, 'accepted');
    assert.equal(body.reason, undefined);
    assert.equal(invoked, false);

    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${String(body.jobId)}.json`);
    const runtimeJson = await readFile(runtimeFile, 'utf8');
    assert.equal(runtimeJson.includes('conn_expired_openai'), false);
  });
});

test('/api/social-content/jobs allows text planning when image/video generation is disabled', async () => {
  await withMarketingRuntimeEnv('tenant_social_route_text_only', async () => {
    (globalThis as Record<string, unknown>).__ARIES_EXECUTION_TEST_INVOKER__ = () => {
      return {
        ok: true,
        status: 'needs_approval',
        output: [
          {
            run_id: 'social-route-text-only',
            executive_summary: {
              market_positioning: 'Research complete.',
              campaign_takeaway: 'Plan ready.',
            },
          },
        ],
        requiresApproval: {
          resumeToken: 'resume_strategy',
          prompt: 'Research complete. Approve strategy to continue.',
        },
      };
    };

    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/social-content/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
            businessType: 'Test vertical',
            primaryGoal: 'Book demos',
            imageCreativeCount: 0,
            videoRenderCount: 0,
          },
        }),
      }),
      async () => ({
        userId: 'user-social-route-text-only',
        tenantId: 'tenant_social_route_text_only',
        tenantSlug: 'tenant-social-route-text-only',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );

    assert.equal(response.status, 202);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.social_content_job_status, 'accepted');
    assert.equal(body.reason, undefined);
    assert.equal(body.message, undefined);
  });
});

test('/api/social-content/jobs preserves user Campaign text while socializing generated status copy', async () => {
  await withMarketingRuntimeEnv('tenant_social_route_campaign_monitor', async () => {
    const { handlePostMarketingJobs } = await import('../app/api/marketing/jobs/handler');
    const { handleGetMarketingJobStatus } = await import('../app/api/marketing/jobs/[jobId]/handler');
    const { loadSocialContentJobRuntime, saveSocialContentJobRuntime } = await import('../backend/marketing/runtime-state');
    const response = await handlePostMarketingJobs(
      new Request('http://aries.example.test/api/social-content/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobType: 'weekly_social_content',
          payload: {
            brandUrl: 'https://brand.example/',
            businessType: 'Campaign Monitor',
            primaryGoal: 'Campaign Monitor launch plan',
            imageCreativeCount: 2,
          },
        }),
      }),
      async () => ({
        userId: 'user-social-route-campaign-monitor',
        tenantId: 'tenant_social_route_campaign_monitor',
        tenantSlug: 'tenant-social-route-campaign-monitor',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );

    assert.equal(response.status, 202);
    const body = (await response.json()) as Record<string, unknown>;
    const doc = await loadSocialContentJobRuntime(String(body.jobId));
    assert.ok(doc);
    doc.state = 'running';
    doc.status = 'running';
    doc.brand_kit = {
      ...(doc.brand_kit ?? {}),
      brand_name: 'Campaign Monitor',
    } as NonNullable<typeof doc.brand_kit>;
    doc.inputs.request.businessType = 'Campaign Monitor';
    doc.inputs.request.primaryGoal = 'Campaign Monitor launch plan';
    saveSocialContentJobRuntime(String(body.jobId), doc);

    const statusResponse = await handleGetMarketingJobStatus(
      String(body.jobId),
      async () => ({
        userId: 'user-social-route-campaign-monitor',
        tenantId: 'tenant_social_route_campaign_monitor',
        tenantSlug: 'tenant-social-route-campaign-monitor',
        role: 'tenant_admin',
      }),
      { responseDialect: 'social-content' },
    );
    const statusBody = (await statusResponse.json()) as {
      tenantName?: string;
      summary?: { headline?: string; subheadline?: string };
      contentBrief?: { businessType?: string; goal?: string };
    };

    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.contentBrief?.businessType, 'Campaign Monitor');
    assert.equal(statusBody.contentBrief?.goal, 'Campaign Monitor launch plan');
    assert.equal(statusBody.summary?.headline, 'Social content job is in progress');
    assert.match(statusBody.summary?.subheadline ?? '', /social content pipeline/i);
  });
});
