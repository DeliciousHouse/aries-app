import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const source = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'onboarding', 'resume', 'page.tsx'),
  'utf8',
);

test('onboarding resume materializes the isolated tenant and workspace after auth', () => {
  assert.match(source, /requireOnboardingDraft/);
  assert.match(source, /createOrganizationWithUniqueSlug/);
  assert.match(source, /assignUserToOrganization/);
  assert.match(source, /tenantIsReusable/);
  assert.match(source, /updateBusinessProfileWithDiagnostics/);
  assert.match(source, /startMarketingJob/);
  assert.match(source, /materializedTenantId/);
  assert.match(source, /materializedJobId/);
  assert.match(source, /\/dashboard\/campaigns\/\$\{encodeURIComponent\(result\.jobId\)\}\?welcome=1/);
  assert.doesNotMatch(source, /derivePublicMarketingTenantId/);
});
