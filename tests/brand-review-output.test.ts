import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const source = readFileSync(
  path.join(PROJECT_ROOT, 'backend', 'marketing', 'workspace-views.ts'),
  'utf8',
);
const buildBrandReviewSlice = source.slice(
  source.indexOf('function buildBrandReview'),
  source.indexOf('function buildStrategyReview'),
);

test('brand review payload leads with customer-readable summaries instead of debug-shaped kit dumps', () => {
  assert.match(buildBrandReviewSlice, /title: 'Brand summary'/);
  assert.match(buildBrandReviewSlice, /title: 'Messaging direction'/);
  assert.match(buildBrandReviewSlice, /title: 'Visual direction'/);
  assert.doesNotMatch(buildBrandReviewSlice, /title: 'Extracted brand kit'/);
  assert.doesNotMatch(buildBrandReviewSlice, /title: 'Design system'/);
  assert.doesNotMatch(buildBrandReviewSlice, /payloads\.designSystemCss/);
});
