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
  assert.match(
    source,
    /const passwordMeetsPolicy = .*test\(password\);/,
    'signup form should derive password policy validity before enabling submit',
  );
  assert.match(
    source,
    /const emailIsValid = .*test\(email\.trim\(\)\);/,
    'signup form should derive email validity before enabling submit',
  );
  assert.match(
    source,
    /const fullNameIsValid = fullName\.trim\(\)\.length > 0;/,
    'signup form should require a non-empty full name before enabling submit',
  );
  assert.match(
    source,
    /const canSubmit = fullNameIsValid && emailIsValid && passwordMeetsPolicy && !isLoading && !isSubmitting;/,
    'signup form should gate submit on required fields, valid email, and password policy',
  );
  assert.match(
    source,
    /disabled=\{!canSubmit\}/,
    'Create account button should stay disabled until the form is actually valid',
  );
  assert.match(
    source,
    /if \(!fullNameIsValid \|\| !emailIsValid \|\| !passwordMeetsPolicy\) return;/,
    'handleSubmit should still short-circuit if a caller bypasses the disabled button state',
  );
});
