import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement } from 'react';

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
import ReviewItemPage from '../app/review/[reviewId]/page';
import ResultsPage from '../app/results/page';
import CalendarPage from '../app/calendar/page';
import PostsPage from '../app/posts/page';
import FeaturesPage from '../app/features/page';
import DocumentationPage from '../app/documentation/page';
import ApiDocsPage from '../app/api-docs/page';
import OnboardingStartPage from '../app/onboarding/start/page';
import PipelineIntakePage from '../app/onboarding/pipeline-intake/page';
import OnboardingStatusPage from '../app/onboarding/status/page';
import MarketingNewJobPage from '../app/marketing/new-job/page';
import MarketingJobStatusPage from '../app/marketing/job-status/page';
import MarketingJobApprovePage from '../app/marketing/job-approve/page';
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
import OnboardingStatusScreen from '../frontend/onboarding/status';
import MarketingNewJobScreen from '../frontend/marketing/new-job';
import MarketingJobStatusScreen from '../frontend/marketing/job-status';
import MarketingJobApproveScreen from '../frontend/marketing/job-approve';
import AppShellLayout from '../frontend/app-shell/layout';

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
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, AriesHomeDashboard);
});

test('/dashboard/campaigns wraps the campaign list in the app shell', () => {
  const element = DashboardCampaignsPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'campaigns');
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
});

test('/dashboard/calendar wraps the calendar screen in the app shell', () => {
  const element = DashboardCalendarPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'calendar');
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

test('/onboarding/start returns the onboarding start screen', () => {
  const element = OnboardingStartPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AriesOnboardingFlow);
});

test('/onboarding/pipeline-intake returns the guided intake workflow', () => {
  const element = PipelineIntakePage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AriesOnboardingFlow);
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

test('/marketing/new-job returns a renderable marketing creation screen', () => {
  const element = MarketingNewJobPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingNewJobScreen);
});

test('/marketing/job-status preserves jobId from the route boundary', async () => {
  const element = await MarketingJobStatusPage({
    searchParams: Promise.resolve({
      jobId: 'mkt_123',
    }),
  });

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingJobStatusScreen);
  assert.equal(element.props.defaultJobId, 'mkt_123');
});

test('/marketing/job-approve preserves the job id from the route boundary', async () => {
  const element = await MarketingJobApprovePage({
    searchParams: Promise.resolve({
      jobId: 'mkt_123',
    }),
  });

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, MarketingJobApproveScreen);
  assert.equal(element.props.defaultJobId, 'mkt_123');
});

test('/platforms redirects to the canonical dashboard settings route', () => {
  expectRedirect(() => PlatformsPage(), '/dashboard/settings');
});

test('/dashboard/settings wraps the settings screen in the app shell', () => {
  expectRedirect(() => DashboardSettingsPage(), '/dashboard/settings/business-profile');
});

test('/settings redirects to the canonical dashboard settings route', () => {
  expectRedirect(() => SettingsPage(), '/dashboard/settings');
});
