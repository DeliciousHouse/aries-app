import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

test('authenticated onboarding flow avoids demo fallbacks and sample tenant defaults', () => {
  const onboardingSource = readFileSync(
    path.join(PROJECT_ROOT, 'frontend/aries-v1/onboarding-flow.tsx'),
    'utf8',
  );
  const loginSource = readFileSync(
    path.join(PROJECT_ROOT, 'app/login/page-client.tsx'),
    'utf8',
  );
  const signUpPageSource = readFileSync(
    path.join(PROJECT_ROOT, 'app/signup/page.tsx'),
    'utf8',
  );
  const signUpFormSource = readFileSync(
    path.join(PROJECT_ROOT, 'frontend/auth/sign-up-form.tsx'),
    'utf8',
  );
  const resumeSource = readFileSync(
    path.join(PROJECT_ROOT, 'app/onboarding/resume/page.tsx'),
    'utf8',
  );

  assert.doesNotMatch(onboardingSource, /mode=demo/);
  assert.doesNotMatch(onboardingSource, /spring-membership-drive/);
  assert.doesNotMatch(onboardingSource, /northstarstudio\.com/i);
  assert.doesNotMatch(onboardingSource, /localpilateshouse\.com/i);
  assert.match(onboardingSource, /createOnboardingDraft/);
  assert.match(onboardingSource, /updateOnboardingDraft/);
  assert.match(onboardingSource, /status: 'ready_for_auth'/);
  assert.match(onboardingSource, /\/onboarding\/resume\?draft=/);
  assert.match(onboardingSource, /draftSaved/);
  assert.match(onboardingSource, /businessName/);
  assert.doesNotMatch(onboardingSource, /\/api\/marketing\/jobs/);
  assert.match(loginSource, /Your setup for/);
  assert.match(loginSource, /callbackUrl/);
  assert.match(signUpPageSource, /callbackUrl/);
  assert.match(signUpPageSource, /Your setup for/);
  assert.match(signUpFormSource, /savedStateMessage/);
  assert.match(resumeSource, /createOrganizationWithUniqueSlug/);
  assert.match(resumeSource, /assignUserToOrganization/);
  assert.match(resumeSource, /updateBusinessProfileWithDiagnostics/);
  assert.match(resumeSource, /startMarketingJob/);
  assert.match(resumeSource, /materializedJobId/);
  assert.match(resumeSource, /\/dashboard\/campaigns\/\$\{encodeURIComponent\(result\.jobId\)\}\?welcome=1/);
});
