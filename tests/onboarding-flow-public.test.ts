import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = readFileSync(
  path.join('/home/node/openclaw/aries-app', 'frontend', 'aries-v1', 'onboarding-flow.tsx'),
  'utf8',
);

test('onboarding flow keeps the live client-facing step order and removes the old welcome-first intake', () => {
  const businessIndex = source.indexOf("label: 'Business'");
  const websiteIndex = source.indexOf("label: 'Website'");
  const brandIndex = source.indexOf("label: 'Brand identity'");
  const channelsIndex = source.indexOf("label: 'Channels'");
  const goalIndex = source.indexOf("label: 'Goal'");

  assert.equal(source.includes("label: 'Welcome'"), false);
  assert.equal(businessIndex >= 0, true);
  assert.equal(websiteIndex > businessIndex, true);
  assert.equal(brandIndex > websiteIndex, true);
  assert.equal(channelsIndex > brandIndex, true);
  assert.equal(goalIndex > channelsIndex, true);
});

test('onboarding flow keeps the website and brand preview client-facing', () => {
  assert.equal(source.includes('Website review'), true);
  assert.equal(source.includes('Brand identity preview'), true);
  assert.equal(source.includes('Logo candidates'), true);
  assert.equal(source.includes('Palette'), true);
  assert.equal(source.includes('Fonts'), true);
  assert.equal(source.includes('Start your first campaign'), true);
  assert.equal(source.includes('POST /api/'), false);
  assert.equal(source.includes('/api/marketing/jobs'), false);
  assert.equal(source.includes('Tenant ID'), false);
  assert.equal(source.includes('Proposed Slug'), false);
  assert.equal(source.includes('Tenant Type'), false);
  assert.equal(source.includes('Signup Event ID'), false);
});

test('onboarding flow avoids raw extraction phrasing and stale operational copy', () => {
  assert.equal(source.includes('Extracting live brand-kit data from the website'), false);
  assert.equal(source.includes('No logo or wordmark candidates were extracted from the live site yet.'), false);
  assert.equal(source.includes('Open Aries'), false);
  assert.equal(source.includes('live runtime'), false);
});
