import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement } from 'react';

import OnboardingStartPage from '../app/onboarding/start/page';
import OnboardingStatusPage from '../app/onboarding/status/page';
import MarketingNewJobPage from '../app/marketing/new-job/page';
import MarketingJobStatusPage from '../app/marketing/job-status/page';
import MarketingJobApprovePage from '../app/marketing/job-approve/page';
import PlatformsPage from '../app/platforms/page';
import SettingsPage from '../app/settings/page';
import OnboardingStartScreen from '../frontend/onboarding/start';
import OnboardingStatusScreen from '../frontend/onboarding/status';
import MarketingNewJobScreen from '../frontend/marketing/new-job';
import MarketingJobStatusScreen from '../frontend/marketing/job-status';
import MarketingJobApproveScreen from '../frontend/marketing/job-approve';
import AppShellLayout from '../frontend/app-shell/layout';
import IntegrationsScreen from '../frontend/settings/integrations';
import SettingsScreen from '../frontend/settings';

test('/onboarding/start returns the onboarding start screen', () => {
  const element = OnboardingStartPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, OnboardingStartScreen);
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

test('/platforms wraps the integrations screen in the app shell', () => {
  const element = PlatformsPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'platforms');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, IntegrationsScreen);
});

test('/settings wraps the settings screen in the app shell', () => {
  const element = SettingsPage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, AppShellLayout);
  assert.equal(element.props.currentRouteId, 'settings');
  assert.equal(isValidElement(element.props.children), true);
  assert.equal(element.props.children.type, SettingsScreen);
});
