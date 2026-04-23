import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const source = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'auth', 'sign-up-form.tsx'),
  'utf8',
);

// Regression: ISSUE-QA-001 — signup submit CTA looked ready before required fields were valid
// Found by /qa on 2026-04-23
// Report: .gstack/qa-reports/qa-report-aries-sugarandleather-com-2026-04-23.md

test('signup submit CTA depends on real form validity, not just loading state', () => {
  assert.ok(
    source.includes('const PASSWORD_POLICY_REGEX = /^(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&]).{8,}$/;'),
    'signup form should define the password policy once so button gating and submit-time validation stay in sync',
  );
  assert.match(
    source,
    /const passwordMeetsPolicy = PASSWORD_POLICY_REGEX\.test\(password\);/,
    'signup form should derive password policy validity before enabling submit',
  );
  assert.match(
    source,
    /const emailIsValid = isValidEmailAddress\(email\);/,
    'signup form should derive email validity before enabling submit',
  );
  assert.match(
    source,
    /const fullNameIsValid = fullName\.trim\(\)\.length > 0;/,
    'signup form should require a non-empty full name before enabling submit',
  );
  assert.match(
    source,
    /const canSubmit = fullNameIsValid && emailIsValid && passwordMeetsPolicy;/,
    'signup form should derive validity from required fields, valid email, and password policy',
  );
  assert.match(
    source,
    /const submitDisabled = useDisabledUntilValid\(canSubmit, isLoading \|\| isSubmitting\);/,
    'signup should gate the submit button through the shared disabled-until-valid helper',
  );
  assert.match(
    source,
    /disabled=\{submitDisabled\}/,
    'Create account button should stay disabled until the form is actually valid',
  );
  assert.match(
    source,
    /if \(isLoading \|\| isSubmitting\) return;/,
    'handleSubmit should ignore programmatic or double submits while auth is already in flight',
  );
  assert.match(
    source,
    /if \(!fullNameIsValid \|\| !emailIsValid \|\| !password\.trim\(\)\) return;/,
    'handleSubmit should still short-circuit if a caller bypasses the disabled button state with missing required fields',
  );
  assert.match(
    source,
    /<p id="signup-email-error" role="alert"/,
    'signup should render inline email validation feedback',
  );
  assert.match(
    source,
    /<p id="signup-password-error" role="alert"/,
    'signup should render inline password validation feedback',
  );
});
