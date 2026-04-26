import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const source = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'business-profile-screen.tsx'),
  'utf8',
);

test('business profile screen uses a curated brand profile presentation', () => {
  assert.equal(source.includes('Business profile'), true);
  assert.equal(source.includes('Current-source identity'), true);
  assert.equal(source.includes('Visual identity'), true);
  assert.equal(source.includes('Visible marks'), true);
  assert.equal(source.includes('Visible brand links'), true);
  assert.equal(source.includes('Derived Brand Context'), false);
  assert.equal(source.includes('Brand-kit signals below are extracted from the saved website'), false);
});

test('business profile screen avoids weak empty-state and operator copy', () => {
  assert.equal(source.includes('No brand voice has been captured yet.'), false);
  assert.equal(source.includes('No style / vibe has been captured yet.'), false);
  assert.equal(source.includes('Logo candidates will appear here'), false);
  assert.equal(source.includes('Palette cues will appear here'), false);
  assert.equal(source.includes('Typography cues will appear here'), false);
  assert.equal(/\bWorkflow checkpoint\b/.test(source), false);
  assert.equal(source.includes('operator tooling'), false);
  assert.equal(source.includes('system reviewer'), false);
  assert.equal(source.includes('resume token'), false);
});

test('business profile screen replaces the comma-list channel editor with curated channel cards', () => {
  assert.equal(source.includes("setChannels("), false);
  assert.equal(source.includes('meta-ads'), true);
  assert.equal(source.includes('Instagram'), true);
  assert.equal(source.includes('Google Business'), true);
  assert.equal(source.includes('LinkedIn'), true);
  assert.equal(source.includes('meta-ads, instagram, linkedin'), false);
});

test('business profile screen offers Add Profile CTA and mirrors connected social profiles', () => {
  assert.equal(
    source.includes('Add Profile'),
    true,
    'Business Profile must expose an Add Profile CTA where account owners manage operating profile channels',
  );
  assert.equal(
    source.includes('/dashboard/settings/channel-integrations?from=business-profile'),
    true,
    'Add Profile CTA should route to the existing channel integration connection page',
  );
  assert.equal(
    source.includes('useIntegrations({ autoLoad: true })'),
    true,
    'Business Profile should load integration cards so newly connected media portals auto-update channel context',
  );
  assert.equal(
    source.includes("connection_state === 'connected'"),
    true,
    'Business Profile should derive connected social profiles from connected integration cards',
  );
  assert.equal(
    source.includes("integrations.data?.status === 'error'"),
    true,
    'Business Profile should show connected profile status as unavailable when the integrations API returns an error payload with HTTP 200',
  );
  assert.equal(
    source.includes('Connected profile status is not available right now.'),
    true,
    'Business Profile should use unavailable copy instead of the no-profiles empty state for integrations error payloads',
  );
  assert.equal(
    source.includes('Connected profiles'),
    true,
    'Business Profile channel section should summarize connected social profiles near the Add Profile CTA',
  );
});
