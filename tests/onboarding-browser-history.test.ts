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

test('onboarding flow persists the current step in URL state and restores it on browser popstate', () => {
  assert.match(source, /searchParams\.get\('step'\)/);
  assert.match(source, /window\.history\.pushState/);
  assert.match(source, /window\.addEventListener\('popstate'/);
  assert.match(source, /setStepIndex\(stepIndexFromStepParam/);
});
