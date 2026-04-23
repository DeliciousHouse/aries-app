import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const source = readFileSync(
  path.join(PROJECT_ROOT, 'components', 'redesign', 'layout', 'app-shell.tsx'),
  'utf8',
);

test('app shell resolves the current tenant from the live membership row before onboarding gate and review count checks', () => {
  assert.match(source, /loadTenantContextForUser/);
  assert.match(source, /liveTenantId = tenantContext\?\.tenantId \?\? null/);
  assert.match(source, /isTenantOnboardingComplete\(\s*client,\s*liveTenantId/);
  assert.match(source, /countPendingMarketingReviewItemsForTenant\(liveTenantId\)/);
  assert.doesNotMatch(source, /countPendingMarketingReviewItemsForTenant\(String\(session\.user\.tenantId\)\)/);
});
