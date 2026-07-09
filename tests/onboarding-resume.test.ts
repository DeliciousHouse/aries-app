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
  assert.doesNotMatch(source, /const draft = await requireOnboardingDraft/);
  assert.match(source, /createOrganizationWithUniqueSlug/);
  assert.match(source, /assignUserToOrganization/);
  assert.match(source, /tenantIsReusable/);
  assert.match(source, /updateBusinessProfileWithDiagnostics/);
  assert.match(source, /startSocialContentJob/);
  assert.match(source, /materializedTenantId/);
  assert.match(source, /materializedJobId/);
  assert.match(source, /\/dashboard\/social-content\/\$\{encodeURIComponent\(result\.jobId\)\}\?welcome=1/);
  assert.doesNotMatch(source, /derivePublicMarketingTenantId/);
});

test('onboarding resume claims materialization once and falls back to a pending handoff screen for duplicate renders', () => {
  assert.match(source, /claimOnboardingDraftMaterialization/);
  assert.match(source, /if \(!claim\.claimed\)/);
  assert.match(source, /OnboardingResumePending/);
  assert.doesNotMatch(source, /updateOnboardingDraft\(draftId, \{ status: 'materializing' \}\)/);
  assert.doesNotMatch(source, /const draft = await requireOnboardingDraft/);
});

test('onboarding resume auto-provisions a default marketing_schedule row, flag-independently (multi-brand workspaces Phase 1a)', () => {
  assert.match(source, /provisionDefaultMarketingSchedule/);

  // Must NOT be gated behind isMultiWorkspaceEnabled(): the schedule hook is
  // common to both the flag-ON and flag-OFF tenant-resolution branches, so it
  // must not be nested inside an `if (isMultiWorkspaceEnabled())` block.
  const multiWorkspaceBlockMatch = source.match(
    /if \(isMultiWorkspaceEnabled\(\)\) \{([\s\S]*?)\n\s*\}/,
  );
  assert.ok(multiWorkspaceBlockMatch, 'expected to find the isMultiWorkspaceEnabled() branch');
  assert.doesNotMatch(multiWorkspaceBlockMatch![1], /provisionDefaultMarketingSchedule/);
});
