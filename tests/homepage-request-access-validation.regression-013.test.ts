import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const source = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'donor', 'marketing', 'home-page.tsx'),
  'utf8',
);

test('homepage request-access form disables submit until the email is valid and shows an inline alert', () => {
  assert.match(
    source,
    /const emailError = emailTouched \? getEmailFieldError\(email, 'your email'\) : null;/,
    'request-access should reuse the shared email validation helper',
  );
  assert.match(
    source,
    /const submitDisabled = useDisabledUntilValid\(isValidEmailAddress\(email\), status === 'loading'\);/,
    'request-access should keep its CTA disabled until the email is valid',
  );
  assert.match(
    source,
    /role="alert"/,
    'request-access should render inline validation feedback as an alert',
  );
  assert.match(
    source,
    /disabled=\{submitDisabled\}/,
    'Request access must stay disabled until the form is valid',
  );
});
