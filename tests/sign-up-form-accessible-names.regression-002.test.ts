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

// Regression: ISSUE-QA-002 — signup controls lacked stable accessible names.
// The password visibility toggle was icon-only, and Organization was named by
// placeholder text instead of the visible label.

test('signup password visibility toggle has updating accessible name and pressed state', () => {
  assert.match(
    source,
    /aria-label=\{showPassword \? 'Hide password' : 'Show password'\}/,
    'password toggle should announce Hide password when pressed and Show password when not pressed',
  );
  assert.match(
    source,
    /aria-pressed=\{showPassword\}/,
    'password toggle should expose its pressed state from showPassword',
  );
  assert.match(
    source,
    /aria-controls="signup-password"/,
    'password toggle should identify the password input it controls',
  );
  assert.match(
    source,
    /type=\{showPassword \? 'text' : 'password'\}/,
    'password input type should still update from the same showPassword state as the toggle name',
  );
  assert.match(
    source,
    /<svg aria-hidden="true" focusable="false" className="w-5 h-5"[\s\S]*?<\/svg>/,
    'password visibility icons should be hidden from assistive technology because the button has the accessible name',
  );
});

test('signup organization input is associated with its visible label', () => {
  assert.match(
    source,
    /<label htmlFor="signup-organization"[^>]*>Organization \{!invitationData && "\(Optional\)"\}<\/label>/,
    'Organization (Optional) should be rendered as a label bound to the organization input',
  );
  assert.match(
    source,
    /<input\s+id="signup-organization"[\s\S]*?placeholder="e\.g\. Acme Corp"/,
    'organization input should carry the id referenced by the visible label instead of relying on placeholder text',
  );
});

test('signup interactive controls do not include an unnamed icon-only button', () => {
  assert.match(
    source,
    /<button[\s\S]*?aria-label=\{showPassword \? 'Hide password' : 'Show password'\}[\s\S]*?<svg aria-hidden="true" focusable="false"/,
    'the icon-only password visibility button must have an accessible name',
  );
});
