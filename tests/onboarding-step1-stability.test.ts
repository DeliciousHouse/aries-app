import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const source = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'onboarding-flow.tsx'),
  'utf8',
);

test('authenticated onboarding drafts update the URL without a router navigation that resets Step 1 state', () => {
  assert.match(source, /window\.history\.replaceState/);
  assert.match(source, /writeOnboardingUrlState/);
  assert.doesNotMatch(source, /router\.replace\(`\/onboarding\/start\?draft=\$\{encodeURIComponent\(nextDraftId\)\}`\)/);
  assert.doesNotMatch(source, /router\.replace\(`\/onboarding\/start\?draft=\$\{encodeURIComponent\(activeDraftId\)\}`\)/);
});
