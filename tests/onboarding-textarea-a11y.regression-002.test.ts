import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const onboardingSource = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'onboarding-flow.tsx'),
  'utf8',
);

// ISSUE-002 — onboarding core-offer textarea was missing accessible name.
// The 'Describe your core offer and customer' textarea on Step 1 of
// /onboarding/start did not appear in the accessibility tree because the
// adjacent question text was a <span>, not a <label>, and the textarea had
// no aria-label or htmlFor binding. The fix wires htmlFor/id so the visible
// question is the textarea's accessible name (no aria-label, which would
// override the visible label and trip WCAG 2.5.3 Label-in-Name).
test('core-offer textarea has an accessible name (htmlFor/id binding only, no aria-label)', () => {
  // The visible question is rendered as a <label> bound to the textarea.
  assert.match(
    onboardingSource,
    /<label\s+htmlFor="onboarding-core-offer"[\s\S]*?>\s*What does your business offer\?\s*<\/label>/,
    'expected the "What does your business offer?" question to be rendered as a <label htmlFor="onboarding-core-offer">',
  );

  // The textarea declares the matching id (no aria-label — the <label> wins).
  assert.match(
    onboardingSource,
    /<textarea[\s\S]*?id="onboarding-core-offer"[\s\S]*?value=\{offer\}/,
    'expected the offer <textarea> to expose id="onboarding-core-offer"',
  );

  // WCAG 2.5.3 Label in Name: the textarea must NOT carry an aria-label,
  // because aria-label would override the <label> in the accessible-name
  // computation and create a mismatch with the visible question text.
  const textareaMatch = onboardingSource.match(
    /<textarea[\s\S]*?id="onboarding-core-offer"[\s\S]*?\/>/,
  );
  assert.ok(textareaMatch, 'expected to locate the core-offer <textarea> tag');
  assert.doesNotMatch(
    textareaMatch![0],
    /aria-label=/,
    'core-offer <textarea> must not declare aria-label; the <label htmlFor> provides the accessible name',
  );

  // Guard against regressing back to a bare <span> for the question text,
  // which is what caused the field to vanish from the accessibility tree.
  assert.doesNotMatch(
    onboardingSource,
    /<span[^>]*>\s*What does your business offer\?\s*<\/span>/,
    'the "What does your business offer?" question must not regress to a non-label <span>',
  );
});
