import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import HomePage from '../app/page';
import DashboardPage from '../app/dashboard/page';
import DashboardBrandReviewPage from '../app/dashboard/brand-review/page';
import DashboardCampaignsPage from '../app/dashboard/campaigns/page';
import DashboardNewCampaignPage from '../app/dashboard/campaigns/new/page';
import DashboardCampaignWorkspacePage from '../app/dashboard/campaigns/[campaignId]/page';
import DashboardCalendarPage from '../app/dashboard/calendar/page';
import DashboardCreativeReviewPage from '../app/dashboard/creative-review/page';
import DashboardPublishStatusPage from '../app/dashboard/publish-status/page';
import DashboardPostsPage from '../app/dashboard/posts/page';
import DashboardResultsPage from '../app/dashboard/results/page';
import DashboardSettingsPage from '../app/dashboard/settings/page';
import DashboardStrategyReviewPage from '../app/dashboard/strategy-review/page';
import CampaignsPage from '../app/campaigns/page';
import CampaignWorkspacePage from '../app/campaigns/[campaignId]/page';
import ReviewQueuePage from '../app/review/page';
import ReviewItemPage, { loadReviewItemPageData } from '../app/review/[reviewId]/page';
import ResultsPage from '../app/results/page';
import CalendarPage from '../app/calendar/page';
import PostsPage from '../app/posts/page';
import FeaturesPage from '../app/features/page';
import DocumentationPage from '../app/documentation/page';
import ApiDocsPage from '../app/api-docs/page';
import OnboardingPage from '../app/onboarding/page';
import OnboardingStartPage from '../app/onboarding/start/page';
import PipelineIntakePage from '../app/onboarding/pipeline-intake/page';
// NOTE: /onboarding/start is now the canonical intake route; pipeline-intake redirects there.
import OnboardingStatusPage from '../app/onboarding/status/page';
import MarketingNewJobPage from '../app/marketing/new-job/page';
import MarketingJobStatusPage from '../app/marketing/job-status/page';
import MarketingJobApprovePage from '../app/marketing/job-approve/page';
import SocialContentNewPage from '../app/social-content/new/page';
import SocialContentStatusPage from '../app/social-content/status/page';
import SocialContentReviewPage from '../app/social-content/review/page';
import PlatformsPage from '../app/platforms/page';
import SettingsPage from '../app/settings/page';
import DonorHomePage from '../frontend/donor/marketing/home-page';
import AriesHomeDashboard from '../frontend/aries-v1/home-dashboard';
import AriesCampaignListScreen from '../frontend/aries-v1/campaign-list';
import AriesCampaignWorkspace from '../frontend/aries-v1/campaign-workspace';
import AriesLatestCampaignView from '../frontend/aries-v1/latest-campaign-view';
import AriesReviewQueueScreen from '../frontend/aries-v1/review-queue';
import AriesReviewItemScreen from '../frontend/aries-v1/review-item';
import AriesCalendarScreen from '../frontend/aries-v1/calendar-screen';
import AriesResultsScreen from '../frontend/aries-v1/results-screen';
import AriesSettingsScreen from '../frontend/aries-v1/settings-screen';
import AriesPostsScreen from '../frontend/aries-v1/posts-screen';
import AriesOnboardingFlow from '../frontend/aries-v1/onboarding-flow';
import MarketingLayout from '../frontend/marketing/MarketingLayout';
import OnboardingStartScreen from '../frontend/onboarding/start';
import OnboardingStatusScreen from '../frontend/onboarding/status';
import MarketingNewJobScreen from '../frontend/marketing/new-job';
import MarketingJobStatusScreen from '../frontend/marketing/job-status';
import MarketingJobApproveScreen from '../frontend/marketing/job-approve';
import SocialContentNewJobScreen from '../frontend/social-content/new-job';
import AppShellLayout from '../frontend/app-shell/layout';
import { buildLoginRedirect } from '../lib/auth/callback-url';
import type { RuntimeReviewItem } from '../lib/api/aries-v1';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function expectRedirect(callable: () => unknown, location: string) {
  assert.throws(callable, (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : String(error), 'NEXT_REDIRECT');
    assert.equal((error as { digest?: string }).digest, `NEXT_REDIRECT;replace;${location};307;`);
    return true;
  });
}

async function expectAsyncRedirect(callable: () => Promise<unknown>, location: string) {
  await assert.rejects(callable, (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : String(error), 'NEXT_REDIRECT');
    assert.equal((error as { digest?: string }).digest, `NEXT_REDIRECT;replace;${location};307;`);
    return true;
  });
}

function makeRuntimeReviewItem(
  id: string,
  overrides: Partial<RuntimeReviewItem> = {},
): RuntimeReviewItem {
  return {
    id,
    jobId: id.split('::')[0] || 'mkt_review_page',
    campaignId: 'campaign_review_page',
    campaignName: 'Review Page Campaign',
    reviewType: 'creative',
    workflowState: 'creative_review_required',
    workflowStage: 'production',
    title: 'Review page asset',
    channel: 'Meta Ads',
    placement: 'Feed',
    scheduledFor: '2026-04-24T17:00:00.000Z',
    status: 'in_review',
    summary: 'Review this asset before launch.',
    currentVersion: {
      id: 'creative:asset',
      label: 'Current version',
      headline: 'Review page asset',
      supportingText: 'Asset copy.',
      cta: 'Approve',
      notes: [],
    },
    lastDecision: null,
    previewUrl: '/api/marketing/jobs/mkt_review_page/assets/asset-preview',
    fullPreviewUrl: '/api/marketing/jobs/mkt_review_page/assets/asset-full',
    contentType: 'image/png',
    destinationUrl: null,
    sections: [],
    attachments: [],
    history: [],
    ...overrides,
  };
}

async function assertReviewPageBodyUsesLoadedReview(review: RuntimeReviewItem) {
  const encodedReviewId = encodeURIComponent(review.id);
  const loaded = await loadReviewItemPageData(encodedReviewId, async () => (
    Response.json({ review })
  ));

  assert.equal(loaded?.review.id, review.id);

  const body = renderToStaticMarkup(createElement(AriesReviewItemScreen, {
    reviewId: review.id,
    initialData: loaded,
  }));

  assert.doesNotMatch(body, /Review item not found/);
  assert.match(body, new RegExp(review.title));
}

test('/ returns the public homepage component', () => {
  const element = HomePage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, DonorHomePage);
});

test('/dashboard wraps the Home screen in the app shell', () => {
  const element = DashboardPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'home');
  assert.equal(element.props.loginRedirectPath, '/dashboard');
  assert.equal(buildLoginRedirect(element.props.loginRedirectPath), '/login?callbackUrl=%2Fdashboard');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesHomeDashboard);
});

test('/dashboard/campaigns wraps the campaign list in the app shell', () => {
  const element = DashboardCampaignsPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'campaigns');
  assert.equal(element.props.loginRedirectPath, '/dashboard/campaigns');
  assert.equal(buildLoginRedirect(element.props.loginRedirectPath), '/login?callbackUrl=%2Fdashboard%2Fcampaigns');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesCampaignListScreen);
});

test('/dashboard/campaigns/new wraps the new campaign flow in the app shell', () => {
  const element = DashboardNewCampaignPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'newCampaign');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, MarketingNewJobScreen);
});

test('/campaigns redirects to the canonical dashboard campaigns route', () => {
  expectRedirect(() => CampaignsPage(), '/dashboard/campaigns');
});

test('/dashboard/campaigns/[campaignId] preserves the campaign id for the workspace', async () => {
  const element = await DashboardCampaignWorkspacePage({
    params: Promise.resolve({
      campaignId: 'spring-atelier-launch',
    }),
    searchParams: Promise.resolve({}),
  });

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'campaigns');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesCampaignWorkspace);
  assert.equal(element.props.children.props.campaignId, 'spring-atelier-launch');
});

test('/dashboard/campaigns/[campaignId] forwards the selected review view into the workspace', async () => {
  const element = await DashboardCampaignWorkspacePage({
    params: Promise.resolve({
      campaignId: 'spring-atelier-launch',
    }),
    searchParams: Promise.resolve({
      view: 'creative',
    }),
  });

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'creativeReview');
  assert.equal(element.props.children.props.initialView, 'creative');
});

test('/campaigns/[campaignId] redirects to the canonical dashboard campaign workspace route', async () => {
  await expectAsyncRedirect(
    () => CampaignWorkspacePage({
      params: Promise.resolve({
        campaignId: 'spring-atelier-launch',
      }),
    }),
    '/dashboard/campaigns/spring-atelier-launch',
  );
});

test('/review wraps the review queue in the app shell', () => {
  const element = ReviewQueuePage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'review');
  assert.equal(element.props.loginRedirectPath, '/review');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesReviewQueueScreen);
});

test('/review/[reviewId] preserves the review id for the review detail experience', async () => {
  const element = await ReviewItemPage({
    params: Promise.resolve({
      reviewId: 'review_meta_launch_hero',
    }),
  });

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'review');
  assert.equal(
    element.props.loginRedirectPath,
    '/review/review_meta_launch_hero',
  );
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesReviewItemScreen);
  assert.equal(element.props.children.props.reviewId, 'review_meta_launch_hero');
});

test('/review/[reviewId] decodes encoded review ids before rendering the detail experience', async () => {
  const element = await ReviewItemPage({
    params: Promise.resolve({
      reviewId: 'mkt_123%3A%3Aapproval',
    }),
  });

  assert.equal(isValidElement(element), true);
  assert.equal(element.props.children.props.reviewId, 'mkt_123::approval');
  assert.equal(
    buildLoginRedirect(element.props.loginRedirectPath),
    '/login?callbackUrl=%2Freview%2Fmkt_123%253A%253Aapproval',
  );
});

test('/review/[reviewId] seeds encoded publish-preview video review data into the rendered page body', async () => {
  await assertReviewPageBodyUsesLoadedReview(makeRuntimeReviewItem(
    'mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63::publish-preview:tiktok',
    {
      reviewType: 'workflow_approval',
      workflowState: 'ready_to_publish',
      workflowStage: 'publish',
      title: 'TikTok publish preview',
      channel: 'TikTok',
      placement: 'Publish preview',
      contentType: 'video/mp4',
      previewUrl: '/api/marketing/jobs/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63/assets/video-tiktok-portrait',
      fullPreviewUrl: '/api/marketing/jobs/mkt_63d45c2b-6f8e-4036-9ebf-703892f3dd63/assets/video-tiktok-portrait',
      currentVersion: {
        id: 'approval:publish-preview:tiktok',
        label: 'Publish preview',
        headline: 'TikTok publish preview',
        supportingText: 'Rendered TikTok video.',
        cta: 'Approve',
        notes: [],
      },
    },
  ));
});

test('/review/[reviewId] seeds encoded creative image review data into the rendered page body', async () => {
  await assertReviewPageBodyUsesLoadedReview(makeRuntimeReviewItem(
    'mkt_c3929018-5bdb-4dfc-83ab-f2ed13bdb97b::creative:image-proof',
    {
      title: 'Creative image proof',
      channel: 'Instagram',
      placement: 'Feed image',
      contentType: 'image/png',
      currentVersion: {
        id: 'creative:image-proof',
        label: 'Image proof',
        headline: 'Creative image proof',
        supportingText: 'Static image creative.',
        cta: 'Approve',
        notes: [],
      },
    },
  ));
});

test('/dashboard/calendar wraps the calendar screen in the app shell', () => {
  const element = DashboardCalendarPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'calendar');
  assert.equal(element.props.loginRedirectPath, '/dashboard/calendar');
  assert.equal(buildLoginRedirect(element.props.loginRedirectPath), '/login?callbackUrl=%2Fdashboard%2Fcalendar');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesCalendarScreen);
});

test('/dashboard/brand-review opens the latest campaign brand review route inside the app shell', () => {
  const element = DashboardBrandReviewPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'brandReview');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesLatestCampaignView);
  assert.equal(element.props.children.props.view, 'brand');
});

test('/dashboard/strategy-review opens the latest campaign strategy review route inside the app shell', () => {
  const element = DashboardStrategyReviewPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'strategyReview');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesLatestCampaignView);
  assert.equal(element.props.children.props.view, 'strategy');
});

test('/dashboard/creative-review opens the latest campaign creative review route inside the app shell', () => {
  const element = DashboardCreativeReviewPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'creativeReview');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesLatestCampaignView);
  assert.equal(element.props.children.props.view, 'creative');
});

test('/dashboard/publish-status opens the latest campaign publish status route inside the app shell', () => {
  const element = DashboardPublishStatusPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'publishStatus');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesLatestCampaignView);
  assert.equal(element.props.children.props.view, 'publish');
});

test('/calendar redirects to the canonical dashboard calendar route', () => {
  expectRedirect(() => CalendarPage(), '/dashboard/calendar');
});

test('/dashboard/posts restores the ready-to-publish inventory in the app shell', () => {
  const element = DashboardPostsPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'posts');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesPostsScreen);
});

test('/posts redirects to the canonical dashboard posts route', () => {
  expectRedirect(() => PostsPage(), '/dashboard/posts');
});

test('/dashboard/results wraps the results screen in the app shell', () => {
  const element = DashboardResultsPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'results');
  assert.equal(element.props.loginRedirectPath, '/dashboard/results');
  assert.equal(buildLoginRedirect(element.props.loginRedirectPath), '/login?callbackUrl=%2Fdashboard%2Fresults');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesResultsScreen);
});

test('/results redirects to the canonical dashboard results route', () => {
  expectRedirect(() => ResultsPage(), '/dashboard/results');
});

test('/features renders inside the marketing layout', () => {
  const element = FeaturesPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingLayout);
});

test('/documentation renders inside the marketing layout', () => {
  const element = DocumentationPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingLayout);
});

test('/api-docs renders inside the marketing layout', () => {
  const element = ApiDocsPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingLayout);
});

test('/onboarding redirects to the canonical premium intake route', () => {
  expectRedirect(() => OnboardingPage(), '/onboarding/start');
});

test('/onboarding/start wires the guided intake workflow behind auth-aware server rendering', () => {
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'app', 'onboarding', 'start', 'page.tsx'),
    'utf8',
  );

  assert.match(source, /auth\(\)/);
  assert.match(source, /<AriesOnboardingFlow initialAuthenticated=\{Boolean\(session\?\.user\?\.id\)\} \/>/);
  assert.notEqual(OnboardingStartPage, OnboardingStartScreen);
  assert.notEqual(AriesOnboardingFlow, OnboardingStartScreen);
});

test('/onboarding/pipeline-intake redirects to /onboarding/start for backwards compatibility', () => {
  expectRedirect(() => PipelineIntakePage(), '/onboarding/start');
});

test('/onboarding/status preserves tenant_id and signup_event_id from the route boundary', async () => {
  const element = await OnboardingStatusPage({
    searchParams: Promise.resolve({
      tenant_id: 'tenant_123',
      signup_event_id: 'signup_evt_456',
    }),
  });

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, OnboardingStatusScreen);
  assert.equal(element.props.initialTenantId, 'tenant_123');
  assert.equal(element.props.initialSignupEventId, 'signup_evt_456');
});

test('/marketing/new-job redirects to the social content intake route', () => {
  expectRedirect(() => MarketingNewJobPage(), '/social-content/new');
});

test('/social-content/new returns a renderable social content creation screen', () => {
  const element = SocialContentNewPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, SocialContentNewJobScreen);
});

test('/social-content/status preserves jobId from the route boundary', async () => {
  const element = await SocialContentStatusPage({
    searchParams: Promise.resolve({
      jobId: 'mkt_123',
    }),
  });

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingJobStatusScreen);
  assert.equal(element.props.defaultJobId, 'mkt_123');
  assert.equal(element.props.jobStatusPath, '/api/social-content/jobs');
  assert.equal(element.props.copyVariant, 'social-content');
});

test('/social-content/review preserves jobId from the route boundary', async () => {
  const element = await SocialContentReviewPage({
    searchParams: Promise.resolve({
      jobId: 'mkt_approve_123',
    }),
  });

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingJobApproveScreen);
  assert.equal(element.props.defaultJobId, 'mkt_approve_123');
  assert.equal(element.props.jobApprovePath, '/api/social-content/jobs');
  assert.equal(element.props.jobStatusPath, '/api/social-content/jobs');
  assert.equal(element.props.copyVariant, 'social-content');
});

test('/social-content/status default render uses social-content wording', async () => {
  const element = await SocialContentStatusPage({
    searchParams: Promise.resolve({}),
  });
  const body = renderToStaticMarkup(element);

  assert.doesNotMatch(body, /campaign/i);
  assert.match(body, /weekly social content status/i);
  assert.match(body, /content job/i);
  assert.match(body, /weekly posts/i);
});

test('/social-content/status screen fetches the social-content job endpoint', async () => {
  const previousFetch = globalThis.fetch;
  const fetchUrls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchUrls.push(typeof input === 'string' ? input : input.toString());
    return new Response(JSON.stringify({
      jobId: 'mkt_123',
      tenantName: null,
      brandWebsiteUrl: null,
      campaignWindow: null,
      durationDays: null,
      plannedPostCount: null,
      createdPostCount: null,
      assetPreviewCards: [],
      calendarEvents: [],
      marketing_job_state: 'completed',
      marketing_job_status: 'completed',
      marketing_stage: null,
      marketing_stage_status: {},
      updatedAt: null,
      needs_attention: false,
      approvalRequired: false,
      summary: {
        headline: 'Weekly social content ready',
        subheadline: 'Weekly posts are ready.',
      },
      stageCards: [],
      artifacts: [],
      timeline: [],
      approval: null,
      reviewBundle: null,
      campaignBrief: null,
      workflowState: 'approved',
      statusHistory: [],
      brandReview: null,
      strategyReview: null,
      creativeReview: null,
      publishConfig: {
        platforms: [],
        livePublishPlatforms: [],
        videoRenderPlatforms: [],
      },
      nextStep: 'wait_for_completion',
      repairStatus: 'none',
      dashboard: {
        campaign: null,
        posts: [],
        assets: [],
        publishItems: [],
        calendarEvents: [],
        statuses: { countsByStatus: {} },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const element = await SocialContentStatusPage({
      searchParams: Promise.resolve({ jobId: 'mkt_123' }),
    });
    const { act, create } = await import('react-test-renderer');

    await act(async () => {
      create(element);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(fetchUrls, ['/api/social-content/jobs/mkt_123']);
    assert.equal(fetchUrls.some((url) => url.includes('/api/marketing/jobs/')), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('/marketing/job-status preserves jobId from the route boundary', async () => {
  await expectAsyncRedirect(
    () =>
      MarketingJobStatusPage({
        searchParams: Promise.resolve({
          jobId: 'mkt_123',
        }),
      }),
    '/social-content/status?jobId=mkt_123',
  );
});

test('/marketing/job-approve preserves the job id from the route boundary', async () => {
  await expectAsyncRedirect(
    () =>
      MarketingJobApprovePage({
        searchParams: Promise.resolve({
          jobId: 'mkt_123',
        }),
      }),
    '/social-content/review?jobId=mkt_123',
  );
});

test('/platforms redirects to the canonical dashboard settings route', () => {
  expectRedirect(() => PlatformsPage(), '/dashboard/settings');
});

test('/dashboard/settings wraps the settings screen in the app shell', () => {
  const element = DashboardSettingsPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'settings');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesSettingsScreen);
});

test('/settings redirects to the canonical dashboard settings route', () => {
  expectRedirect(() => SettingsPage(), '/dashboard/settings');
});
