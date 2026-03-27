import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

test('authenticated onboarding flow avoids demo fallbacks and sample tenant defaults', () => {
  const source = readFileSync(
    path.join(PROJECT_ROOT, 'frontend/aries-v1/onboarding-flow.tsx'),
    'utf8',
  );

  assert.doesNotMatch(source, /mode=demo/);
  assert.doesNotMatch(source, /spring-membership-drive/);
  assert.doesNotMatch(source, /northstarstudio\.com/i);
  assert.doesNotMatch(source, /localpilateshouse\.com/i);
  assert.match(source, /useBusinessProfile/);
  assert.match(source, /\/dashboard\/campaigns\/\$\{encodeURIComponent\(result\.jobId\)\}/);
});
