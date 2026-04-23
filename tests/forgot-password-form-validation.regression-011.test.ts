import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const source = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'auth', 'ForgotPasswordForm.tsx'),
  'utf8',
);

test('forgot-password form blocks invalid emails and renders inline alerts', () => {
  assert.match(
    source,
    /const emailError = emailTouched \? getEmailFieldError\(email, 'your account email'\) : null;/,
    'forgot-password should reuse the shared email validator',
  );
  assert.match(
    source,
    /const submitDisabled = useDisabledUntilValid\(\s*isValidEmailAddress\(email\),\s*isLoading \|\| parentLoading,\s*\);/,
    'forgot-password should disable submit until the email is valid',
  );
  assert.match(
    source,
    /<p id="forgot-password-email-error" role="alert"/,
    'forgot-password should show inline email validation feedback',
  );
  assert.match(
    source,
    /disabled=\{submitDisabled\}/,
    'Send Recovery Code must stay disabled until the form is valid',
  );
});
