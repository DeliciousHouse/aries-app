import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const formSource = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'auth', 'reset-password-form.tsx'),
  'utf8',
);
const pageSource = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'reset-password', 'page-client.tsx'),
  'utf8',
);

test('reset password displays backend failures as accessible alerts', () => {
  assert.match(
    pageSource,
    /if \(!response\.ok\) \{[\s\S]*Your recovery code is invalid or expired\. Request a new code and try again\.[\s\S]*throw new Error\(data\.error\?\.trim\(\) \|\| fallbackMessage\);[\s\S]*\}/,
    'reset page should turn non-2xx reset responses into visible invalid/expired-code errors',
  );
  assert.match(
    formSource,
    /catch \(err: any\) \{\s*setError\(err\?\.message \|\| "Failed to update password\. Try again\."\);\s*\}/,
    'reset form should preserve failed reset errors from the page submit handler',
  );
  assert.match(
    formSource,
    /\{error && \([\s\S]*role="alert"[\s\S]*\{error\}[\s\S]*\)\}/,
    'reset form should render submit failures in an accessible alert region',
  );
});

test('reset password blocks submit until code, password policy, and confirmation are valid', () => {
  assert.ok(
    formSource.includes('const PASSWORD_POLICY_REGEX = /^(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&]).{8,}$/;'),
    'reset form should define the password policy once so button gating and submit-time validation stay in sync',
  );
  assert.ok(
    formSource.includes('const codeIsValid = /^\\d{6}$/.test(normalizedCode);'),
    'reset form should require a six-digit recovery code before enabling submit',
  );
  assert.match(
    formSource,
    /const passwordMeetsPolicy = PASSWORD_POLICY_REGEX\.test\(password\);/,
    'reset form should require the password to satisfy the policy before enabling submit',
  );
  assert.match(
    formSource,
    /const passwordsMatch = confirmPassword\.length > 0 && password === confirmPassword;/,
    'reset form should require confirmation to match before enabling submit',
  );
  assert.match(
    formSource,
    /const canSubmit = codeIsValid && passwordMeetsPolicy && passwordsMatch;/,
    'reset form should derive submit validity from code, password, and confirmation validity',
  );
  assert.match(
    formSource,
    /const submitDisabled = useDisabledUntilValid\(canSubmit, isLoading\);/,
    'reset form should gate the submit button through the shared disabled-until-valid helper',
  );
  assert.match(
    formSource,
    /disabled=\{submitDisabled\}/,
    'Update Password should stay disabled until the reset form is valid',
  );
  assert.match(
    formSource,
    /if \(!canSubmit\) \{\s*return;\s*\}/,
    'handleSubmit should still block invalid programmatic submits before the backend request',
  );
});

test('reset password shows inline validation and labels each input with the visible label', () => {
  assert.match(
    formSource,
    /<p id="reset-password-code-error" role="alert"/,
    'reset form should show inline recovery-code validation feedback',
  );
  assert.match(
    formSource,
    /<p id="reset-password-new-password-error" role="alert"/,
    'reset form should show inline password-policy validation feedback',
  );
  assert.match(
    formSource,
    /<p id="reset-password-confirm-password-error" role="alert"/,
    'reset form should show inline confirmation mismatch validation feedback',
  );
  assert.match(
    formSource,
    /<label htmlFor="reset-password-code" className="auth-label">Recovery Code<\/label>[\s\S]*id="reset-password-code"/,
    'Recovery Code input should be named by its visible label',
  );
  assert.match(
    formSource,
    /<label htmlFor="reset-password-new-password" className="auth-label">New Password<\/label>[\s\S]*id="reset-password-new-password"/,
    'New Password input should be named by its visible label',
  );
  assert.match(
    formSource,
    /<label htmlFor="reset-password-confirm-password" className="auth-label">Confirm Password<\/label>[\s\S]*id="reset-password-confirm-password"/,
    'Confirm Password input should be named by its visible label',
  );
});
