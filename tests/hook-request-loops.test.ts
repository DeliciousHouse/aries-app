import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';

import { useBusinessProfile } from '../hooks/use-business-profile';
import { useIntegrations } from '../hooks/use-integrations';
import { useLatestMarketingJob } from '../hooks/use-latest-marketing-job';
import { useTenantWorkflows } from '../hooks/use-tenant-workflows';

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function dashboardLikeLatestJobResponse() {
  return {
    jobId: 'mkt_123',
    tenantName: 'Sugar & Leather',
    brandWebsiteUrl: 'https://sugarandleather.com',
    campaignWindow: null,
    durationDays: null,
    plannedPostCount: null,
    createdPostCount: null,
    assetPreviewCards: [],
    calendarEvents: [],
    marketing_job_state: 'running',
    marketing_job_status: 'running',
    marketing_stage: 'research',
    marketing_stage_status: {
      research: 'running',
      strategy: 'not_started',
      production: 'not_started',
      publish: 'not_started',
    },
    updatedAt: new Date().toISOString(),
    needs_attention: false,
    approvalRequired: false,
    summary: {
      headline: 'Campaign is running',
      subheadline: 'Research is in progress.',
    },
    stageCards: [],
    artifacts: [],
    timeline: [],
    approval: null,
    reviewBundle: null,
    publishConfig: {
      platforms: [],
      livePublishPlatforms: [],
      videoRenderPlatforms: [],
    },
    nextStep: 'wait_for_completion',
    repairStatus: 'not_required',
  };
}

function DashboardHooksHarness() {
  useLatestMarketingJob({ autoLoad: true });
  useIntegrations();
  useTenantWorkflows();
  useBusinessProfile({ autoLoad: true });
  return React.createElement('div', null, 'dashboard-data');
}

test('dashboard data hooks auto-load once instead of looping requests after success', async () => {
  const previousFetch = globalThis.fetch;
  const counts = new Map<string, number>();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, 'https://aries.sugarandleather.com').pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);

    if (path === '/api/marketing/jobs/latest') {
      return new Response(JSON.stringify(dashboardLikeLatestJobResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (path === '/api/integrations') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          page_state: 'ready',
          supported_platforms: [],
          cards: [],
          summary: { total: 0, connected: 0, not_connected: 0, attention_required: 0 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }

    if (path === '/api/tenant/workflows') {
      return new Response(JSON.stringify({ workflows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (path === '/api/business/profile') {
      return new Response(
        JSON.stringify({
          profile: {
            tenantId: '11',
            businessName: 'Sugar & Leather',
            tenantSlug: 'sugar-leather',
            websiteUrl: 'https://sugarandleather.com',
            businessType: 'retail',
            primaryGoal: 'grow-repeat-sales',
            launchApproverUserId: null,
            launchApproverName: null,
            brandKit: null,
            incomplete: false,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }

    if (path === '/api/tenant/profiles') {
      return new Response(JSON.stringify({ profiles: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch in hook loop test: ${path}`);
  }) as typeof fetch;

  try {
    const { act, create } = await import('react-test-renderer');

    let root: import('react-test-renderer').ReactTestRenderer | null = null;
    await act(async () => {
      root = create(React.createElement(DashboardHooksHarness));
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    assert.ok(root);
    assert.equal(counts.get('/api/marketing/jobs/latest'), 1);
    assert.equal(counts.get('/api/integrations'), 1);
    assert.equal(counts.get('/api/tenant/workflows'), 1);
    assert.equal(counts.get('/api/business/profile'), 1);
    assert.equal(counts.get('/api/tenant/profiles'), 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('business profile auto-load does not retry forever after request failures', async () => {
  const previousFetch = globalThis.fetch;
  const counts = new Map<string, number>();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, 'https://aries.sugarandleather.com').pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);

    if (path === '/api/business/profile' || path === '/api/tenant/profiles') {
      return new Response(JSON.stringify({ error: 'upstream failure' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch in business-profile failure test: ${path}`);
  }) as typeof fetch;

  function BusinessProfileHarness() {
    useBusinessProfile({ autoLoad: true });
    return React.createElement('div', null, 'business-profile');
  }

  try {
    const { act, create } = await import('react-test-renderer');

    await act(async () => {
      create(React.createElement(BusinessProfileHarness));
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    assert.equal(counts.get('/api/business/profile'), 1);
    assert.equal(counts.get('/api/tenant/profiles'), 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('latest marketing job auto-load does not retry forever on 404', async () => {
  const previousFetch = globalThis.fetch;
  let latestCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, 'https://aries.sugarandleather.com').pathname;
    if (path !== '/api/marketing/jobs/latest') {
      throw new Error(`Unexpected fetch in latest-job 404 test: ${path}`);
    }

    latestCalls += 1;
    return new Response(JSON.stringify({ error: 'Marketing job not found.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  function LatestJobHarness() {
    useLatestMarketingJob({ autoLoad: true });
    return React.createElement('div', null, 'latest-job');
  }

  try {
    const { act, create } = await import('react-test-renderer');

    await act(async () => {
      create(React.createElement(LatestJobHarness));
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    assert.equal(latestCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
