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
const onboardingFlowSource = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'onboarding-flow.tsx'),
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

test('onboarding keeps offer, brand voice, and revision notes distinct when materializing the first job', () => {
  const profileUpdate = source.match(
    /updateBusinessProfileWithDiagnostics\(client,\s*\{([\s\S]*?)\n\s*\}\);/,
  );
  assert.ok(profileUpdate, 'expected the materialization profile update');
  assert.match(profileUpdate[1], /offer: claim\.draft\.offer \|\| null/);
  assert.match(profileUpdate[1], /brandVoice: claim\.draft\.brandVoice,/);
  assert.match(profileUpdate[1], /notes: claim\.draft\.notes,/);
  assert.doesNotMatch(source, /notes:\s*claim\.draft\.preview\?\.description/);
});

test('onboarding lets the user confirm or correct scraped identity before first generation', () => {
  assert.match(onboardingFlowSource, /Brand voice/);
  assert.match(onboardingFlowSource, /Offer summary/);
  assert.match(onboardingFlowSource, /Revision notes/);
  assert.match(onboardingFlowSource, /onChange=\{\(event\) => \{[\s\S]*?setBrandVoice\(event\.target\.value\);/);
  assert.match(onboardingFlowSource, /onChange=\{\(event\) => setNotes\(event\.target\.value\)\}/);

  const firstGeneration = onboardingFlowSource.indexOf('startSocialContentJob');
  assert.equal(firstGeneration, -1, 'the client must persist confirmation before server-side generation starts');
  assert.match(onboardingFlowSource, /brandVoice,/);
  assert.match(onboardingFlowSource, /notes,/);
});
