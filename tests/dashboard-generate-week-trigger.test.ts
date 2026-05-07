import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { IntegrationCard } from '../lib/api/integrations';
import type {
  AriesDashboardStatusSummary,
  BusinessProfileView,
  RuntimeCampaignListItem,
} from '../lib/api/aries-v1';
import { createDashboardHomeViewModel } from '../frontend/aries-v1/view-models/dashboard-home';
import {
  GENERATE_THIS_WEEK_LABEL,
  GENERATE_THIS_WEEK_BUSY_LABEL,
  GENERATE_THIS_WEEK_ENDPOINT,
  buildGenerateThisWeekRequestBody,
  customerSafeGenerateThisWeekError,
  evaluateGenerateThisWeekGate,
  submitGenerateThisWeek,
} from '../frontend/aries-v1/generate-this-week';
import DashboardHomePresenter from '../frontend/aries-v1/presenters/dashboard-home-presenter';

function buildStatusSummary(): AriesDashboardStatusSummary {
  return {
    countsByStatus: {
      draft: 0,
      in_review: 0,
      ready: 0,
      ready_to_publish: 0,
      published_to_meta_paused: 0,
      scheduled: 0,
      live: 0,
    },
  };
}

function buildCampaign(
  overrides: Partial<RuntimeCampaignListItem> = {},
): RuntimeCampaignListItem {
  return {
    id: 'campaign-1',
    jobId: 'campaign-1',
    name: 'Campaign Alpha',
    objective: 'Drive demo requests',
    funnelStage: 'Conversion',
    status: 'approved',
    dashboardStatus: 'ready_to_publish',
    stageLabel: 'production',
    summary: 'Proof-led launch campaign.',
    dateRange: 'Dates not scheduled yet',
    pendingApprovals: 0,
    nextScheduled: 'Nothing scheduled yet',
    trustNote: 'Nothing goes live without approval.',
    updatedAt: '2026-05-01T00:00:00.000Z',
    approvalRequired: false,
    counts: {
      posts: 1,
      landingPages: 0,
      imageAds: 0,
      videoAds: 0,
      scripts: 0,
      publishItems: 0,
      proposalConcepts: 0,
      ready: 0,
      readyToPublish: 0,
      pausedMetaAds: 0,
      scheduled: 0,
      live: 0,
    },
    previewPosts: [],
    previewAssets: [],
    dashboard: {
      campaign: null,
      posts: [],
      assets: [],
      publishItems: [],
      calendarEvents: [],
      statuses: buildStatusSummary(),
    },
    ...overrides,
  };
}

function buildProfile(overrides: Partial<BusinessProfileView> = {}): BusinessProfileView {
  return {
    tenantId: 'tenant-1',
    businessName: 'Acme Co',
    tenantSlug: 'acme',
    websiteUrl: 'https://acme.example',
    businessType: 'SaaS',
    primaryGoal: 'demos',
    launchApproverUserId: null,
    launchApproverName: null,
    offer: null,
    brandVoice: null,
    styleVibe: null,
    notes: null,
    competitorUrl: null,
    channels: ['meta', 'instagram'],
    brandIdentity: null,
    brandKit: {
      brand_name: 'Acme',
      source_url: 'https://acme.example',
      canonical_url: 'https://acme.example',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: '2026-05-01T00:00:00.000Z',
      brand_voice_summary: null,
      offer_summary: null,
    },
    incomplete: false,
    ...overrides,
  };
}

function buildIntegration(
  overrides: Partial<IntegrationCard> = {},
): IntegrationCard {
  return {
    platform: 'facebook',
    display_name: 'Facebook',
    description: 'Publish to a Facebook Page.',
    connection_state: 'connected',
    health: 'healthy',
    available_actions: ['disconnect', 'sync_now'],
    last_synced_at: '2026-05-01T00:00:00.000Z',
    permissions: [],
    ...overrides,
  };
}

test('gate is ready when profile is complete and a Meta channel is connected', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: buildProfile(),
    integrationCards: [buildIntegration()],
    campaigns: [],
  });
  assert.equal(state.gate, 'ready');
  assert.equal(state.enabled, true);
  assert.equal(state.inProgress, false);
  assert.equal(state.disabledReason, null);
});

test('gate blocks when profile is incomplete', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: buildProfile({ incomplete: true }),
    integrationCards: [buildIntegration()],
    campaigns: [],
  });
  assert.equal(state.gate, 'profile_incomplete');
  assert.equal(state.enabled, false);
  assert.match(state.disabledReason ?? '', /profile/i);
});

test('gate blocks when no Facebook or Instagram connection is present', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: buildProfile(),
    integrationCards: [
      buildIntegration({ platform: 'linkedin', connection_state: 'connected' }),
      buildIntegration({ platform: 'facebook', connection_state: 'reauth_required' }),
    ],
    campaigns: [],
  });
  assert.equal(state.gate, 'no_meta_connection');
  assert.equal(state.enabled, false);
  assert.match(state.disabledReason ?? '', /facebook|instagram/i);
});

test('Instagram connected without Facebook still satisfies the gate', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: buildProfile(),
    integrationCards: [buildIntegration({ platform: 'instagram', connection_state: 'connected' })],
    campaigns: [],
  });
  assert.equal(state.gate, 'ready');
  assert.equal(state.enabled, true);
});

test('gate blocks while integrations are still loading', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: buildProfile(),
    integrationCards: [],
    integrationsPending: true,
    campaigns: [],
  });
  assert.equal(state.gate, 'integrations_loading');
  assert.equal(state.enabled, false);
});

test('a draft dashboard campaign counts as in-progress and outranks all other gates', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: buildProfile({ incomplete: true }),
    integrationCards: [],
    campaigns: [
      {
        status: 'draft',
        dashboardStatus: 'draft',
        approvalRequired: false,
      },
    ],
  });
  assert.equal(state.gate, 'in_progress');
  assert.equal(state.enabled, false);
  assert.equal(state.inProgress, true);
});

test('an in_review campaign counts as in-progress', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: buildProfile(),
    integrationCards: [buildIntegration()],
    campaigns: [
      {
        status: 'in_review',
        dashboardStatus: 'in_review',
        approvalRequired: false,
      },
    ],
  });
  assert.equal(state.gate, 'in_progress');
  assert.equal(state.enabled, false);
});

test('approvalRequired alone counts as in-progress even when statuses are terminal', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: buildProfile(),
    integrationCards: [buildIntegration()],
    campaigns: [
      {
        status: 'approved',
        dashboardStatus: 'ready_to_publish',
        approvalRequired: true,
      },
    ],
  });
  assert.equal(state.gate, 'in_progress');
  assert.equal(state.enabled, false);
});

test('a fully live or scheduled campaign does NOT block another generation', () => {
  const state = evaluateGenerateThisWeekGate({
    profile: buildProfile(),
    integrationCards: [buildIntegration()],
    campaigns: [
      {
        status: 'live',
        dashboardStatus: 'live',
        approvalRequired: false,
      },
      {
        status: 'scheduled',
        dashboardStatus: 'scheduled',
        approvalRequired: false,
      },
    ],
  });
  assert.equal(state.gate, 'ready');
  assert.equal(state.enabled, true);
});

test('view-model exposes the exact required label and reflects the gate', () => {
  const model = createDashboardHomeViewModel({
    campaigns: [],
    reviews: [],
    profile: buildProfile(),
    integrationCards: [buildIntegration()],
  });
  assert.equal(model.generateThisWeek.label, "Generate this week's content");
  assert.equal(model.generateThisWeek.label, GENERATE_THIS_WEEK_LABEL);
  assert.equal(model.generateThisWeek.enabled, true);
  assert.equal(model.generateThisWeek.gate, 'ready');
  assert.equal(model.generateThisWeek.inProgress, false);
});

test('view-model surfaces the in-progress disabled reason when a draft campaign exists', () => {
  const model = createDashboardHomeViewModel({
    campaigns: [buildCampaign({ status: 'draft', dashboardStatus: 'draft' })],
    reviews: [],
    profile: buildProfile(),
    integrationCards: [buildIntegration()],
  });
  assert.equal(model.generateThisWeek.enabled, false);
  assert.equal(model.generateThisWeek.gate, 'in_progress');
  assert.match(model.generateThisWeek.disabledReason ?? '', /in progress/i);
});

test('busy label and endpoint constants are stable wire-format anchors', () => {
  assert.equal(GENERATE_THIS_WEEK_BUSY_LABEL, 'Generating…');
  assert.equal(GENERATE_THIS_WEEK_ENDPOINT, '/api/social-content/jobs');
});

test('request body contains weekly_social_content jobType and an empty payload', () => {
  const body = buildGenerateThisWeekRequestBody();
  assert.equal(body.jobType, 'weekly_social_content');
  assert.deepEqual(body.payload, {});
  assert.equal(Object.keys(body.payload).length, 0);
});

test('submitGenerateThisWeek POSTs JSON to the social-content jobs endpoint', async () => {
  const calls: Array<{
    url: string;
    method?: string;
    body: unknown;
    contentType: string | null;
  }> = [];
  const fakeFetch: typeof fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headersInit = init?.headers as Record<string, string> | undefined;
    calls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      contentType: headersInit?.['Content-Type'] ?? null,
    });
    return new Response(
      JSON.stringify({ jobId: 'job_123', jobStatusUrl: '/social-content/status?jobId=job_123' }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const result = await submitGenerateThisWeek(fakeFetch);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/social-content/jobs');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].contentType, 'application/json');
  assert.deepEqual(calls[0].body, { jobType: 'weekly_social_content', payload: {} });
  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.equal(result.jobId, 'job_123');
  assert.equal(result.jobStatusUrl, '/social-content/status?jobId=job_123');
  assert.equal(result.errorMessage, null);
});

test('submitGenerateThisWeek surfaces server error message on non-2xx responses', async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response(JSON.stringify({ error: 'unsupported_job_type:foo' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const result = await submitGenerateThisWeek(fakeFetch);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.errorMessage, 'unsupported_job_type:foo');
  assert.equal(result.jobId, null);
});

test('customerSafeGenerateThisWeekError redacts internal-sounding error tokens', () => {
  const redacted = customerSafeGenerateThisWeekError(
    'oauth_token_encryption_key missing env',
  );
  assert.doesNotMatch(redacted, /oauth/i);
  assert.doesNotMatch(redacted, /env/i);
  assert.match(redacted, /could not start|please try again|not available/i);
});

test('customerSafeGenerateThisWeekError keeps short, customer-facing copy intact', () => {
  const friendly = 'Connect a Facebook page first.';
  assert.equal(customerSafeGenerateThisWeekError(friendly), friendly);
});

test('customerSafeGenerateThisWeekError returns the fallback for null input', () => {
  const out = customerSafeGenerateThisWeekError(null);
  assert.match(out, /could not start/i);
});

function buildPresenterModel() {
  return createDashboardHomeViewModel({
    campaigns: [],
    reviews: [],
    profile: buildProfile(),
    integrationCards: [buildIntegration()],
  });
}

function renderPresenterMarkup(
  generateThisWeek:
    | {
        submitting: boolean;
        errorMessage: string | null;
        jobStatusUrl: string | null;
        onTrigger: () => void;
      }
    | undefined,
): string {
  return renderToStaticMarkup(
    React.createElement(DashboardHomePresenter, {
      model: buildPresenterModel(),
      generateThisWeek,
    }),
  );
}

test('presenter renders the visible status link after a successful run', () => {
  const markup = renderPresenterMarkup({
    submitting: false,
    errorMessage: null,
    jobStatusUrl: '/social-content/status?jobId=job_xyz',
    onTrigger: () => {},
  });
  assert.match(markup, /data-testid="generate-this-week-success"/);
  assert.match(
    markup,
    /<a[^>]*data-testid="generate-this-week-status-link"[^>]*href="\/social-content\/status\?jobId=job_xyz"/,
  );
  assert.match(markup, />View status<\/a>|>View status</);
});

test('presenter does NOT render the status link when no jobStatusUrl is set', () => {
  const markup = renderPresenterMarkup({
    submitting: false,
    errorMessage: null,
    jobStatusUrl: null,
    onTrigger: () => {},
  });
  assert.doesNotMatch(markup, /data-testid="generate-this-week-status-link"/);
  assert.doesNotMatch(markup, /data-testid="generate-this-week-success"/);
});

function findButtonTag(markup: string): string {
  const match = markup.match(/<button[^>]*generate-this-week-button[^>]*>/);
  assert.ok(match, 'expected the trigger button to render');
  return match[0];
}

test('presenter disables the trigger button while a status link is showing', () => {
  const markup = renderPresenterMarkup({
    submitting: false,
    errorMessage: null,
    jobStatusUrl: '/social-content/status?jobId=job_disable',
    onTrigger: () => {},
  });
  const tag = findButtonTag(markup);
  assert.match(tag, /\sdisabled(?:=""|\s|>)/);
  assert.match(tag, /aria-disabled="true"/);
});

test('presenter shows the busy label and no status link while submitting', () => {
  const markup = renderPresenterMarkup({
    submitting: true,
    errorMessage: null,
    jobStatusUrl: null,
    onTrigger: () => {},
  });
  const tag = findButtonTag(markup);
  assert.match(tag, /\sdisabled(?:=""|\s|>)/);
  assert.match(tag, /aria-busy="true"/);
  assert.match(markup, new RegExp(GENERATE_THIS_WEEK_BUSY_LABEL));
  assert.doesNotMatch(markup, /data-testid="generate-this-week-status-link"/);
});

test('presenter renders the disabled trigger when generateThisWeek prop is omitted', () => {
  const markup = renderPresenterMarkup(undefined);
  const tag = findButtonTag(markup);
  assert.match(tag, /\sdisabled(?:=""|\s|>)/);
  assert.doesNotMatch(markup, /data-testid="generate-this-week-status-link"/);
});
