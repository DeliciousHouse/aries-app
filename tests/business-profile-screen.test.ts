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
