import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const onboardingSource = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'onboarding-flow.tsx'),
  'utf8',
);
const startPageSource = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'onboarding', 'start', 'page.tsx'),
  'utf8',
);
const startScreenSource = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'onboarding', 'start.tsx'),
  'utf8',
);

test('public onboarding boundary redirects to premium intake and removes the raw tenant-onboarding copy', () => {
  assert.match(startPageSource, /redirect\('\/onboarding\/pipeline-intake'\)/);
  assert.doesNotMatch(startScreenSource, /Start Onboarding/);
  assert.doesNotMatch(startScreenSource, /Collect required onboarding start fields/);
  assert.doesNotMatch(startScreenSource, /Tenant ID/);
  assert.doesNotMatch(startScreenSource, /Proposed Slug/);
  assert.doesNotMatch(startScreenSource, /Tenant Type/);
  assert.doesNotMatch(startScreenSource, /Signup Event ID/);
  assert.match(startScreenSource, /Tenant onboarding tooling moved off the public path/);
});

test('onboarding flow keeps the live client-facing step order and removes the old welcome-first intake', () => {
  const businessIndex = onboardingSource.indexOf("label: 'Business'");
  const websiteIndex = onboardingSource.indexOf("label: 'Website'");
  const brandIndex = onboardingSource.indexOf("label: 'Brand identity'");
  const channelsIndex = onboardingSource.indexOf("label: 'Channels'");
  const goalIndex = onboardingSource.indexOf("label: 'Goal'");

  assert.equal(onboardingSource.includes("label: 'Welcome'"), false);
  assert.equal(businessIndex >= 0, true);
  assert.equal(websiteIndex > businessIndex, true);
  assert.equal(brandIndex > websiteIndex, true);
  assert.equal(channelsIndex > brandIndex, true);
  assert.equal(goalIndex > channelsIndex, true);
});

test('onboarding flow keeps website and brand preview customer-facing without exposing internal onboarding fields', () => {
  assert.equal(onboardingSource.includes('Website review'), true);
  assert.equal(onboardingSource.includes('Brand identity preview'), true);
  assert.equal(onboardingSource.includes('POST /api/'), false);
  assert.equal(onboardingSource.includes('/api/marketing/jobs'), false);
  assert.equal(onboardingSource.includes('/api/business/profile'), false);
  assert.equal(onboardingSource.includes('Tenant ID'), false);
  assert.equal(onboardingSource.includes('Proposed Slug'), false);
  assert.equal(onboardingSource.includes('Tenant Type'), false);
  assert.equal(onboardingSource.includes('Signup Event ID'), false);
});

test('first-run onboarding requires explicit channel and goal confirmation', () => {
  assert.match(onboardingSource, /const \[selectedChannels, setSelectedChannels\] = useState<string\[\]>\(\[\]\)/);
  assert.match(onboardingSource, /const \[goal, setGoal\] = useState\(''\)/);
  assert.match(onboardingSource, /selectedChannels\.length > 0/);
  assert.match(onboardingSource, /goal\.trim\(\)\.length > 0/);
  assert.match(onboardingSource, /Select at least one channel before continuing\./);
  assert.match(onboardingSource, /Choose the primary goal for the first campaign\./);
});
