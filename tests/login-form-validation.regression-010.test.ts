import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const source = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'auth', 'login-form.tsx'),
  'utf8',
);

test('login form keeps Sign in disabled until credentials are valid and exposes inline alerts', () => {
  assert.match(
    source,
    /const emailError = emailTouched \? getEmailFieldError\(email\) : null;/,
    'login should derive its email error from the shared helper',
  );
  assert.match(
    source,
    /const credentialsAreValid = isValidEmailAddress\(email\) && password\.trim\(\)\.length > 0;/,
    'login should require a syntactically valid email and non-empty password before enabling submit',
  );
  assert.match(
    source,
    /const submitDisabled = useDisabledUntilValid\(credentialsAreValid, isLoading\);/,
    'login should use the shared disabled-until-valid helper',
  );
  assert.match(
    source,
    /<p id="login-email-error" role="alert"/,
    'login should render inline email validation feedback as an alert',
  );
  assert.match(
    source,
    /disabled=\{submitDisabled\}/,
    'Sign in must stay disabled until the login form is valid',
  );
});
