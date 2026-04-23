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

test('signup submit trims the validated email before registration and auth handoff', () => {
  assert.match(
    source,
    /const normalizedEmail = email\.trim\(\);/,
    'signup should normalize the email once at submit time',
  );
  assert.match(
    source,
    /await registerUserAction\(\{\s*email: normalizedEmail,/s,
    'signup should register with the trimmed email value',
  );
  assert.match(
    source,
    /const submitResult = await onSubmit\(normalizedEmail, password\);/,
    'signup should pass the trimmed email into the follow-on auth submit',
  );
});
