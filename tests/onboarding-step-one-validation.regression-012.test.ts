import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const source = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'onboarding-flow.tsx'),
  'utf8',
);

test('onboarding step one keeps Continue disabled until goal and offer are valid with inline alerts', () => {
  assert.match(
    source,
    /return values\.goal\.trim\(\)\.length > 0 && values\.offer\.trim\(\)\.length > 0;/,
    'step-one validity should require both a selected goal and a non-empty offer summary',
  );
  assert.match(
    source,
    /const continueDisabled = useDisabledUntilValid\(currentStepIsReady, submitting \|\| creatingDraft\);/,
    'onboarding should use the shared disabled-until-valid helper for Continue',
  );
  assert.match(
    source,
    /<p id="onboarding-goal-error" role="alert"/,
    'onboarding should render an inline goal validation alert',
  );
  assert.match(
    source,
    /<p id="onboarding-offer-error" role="alert"/,
    'onboarding should render an inline offer validation alert',
  );
  assert.match(
    source,
    /disabled=\{continueDisabled\}/,
    'Continue should stay disabled until the current onboarding step is valid',
  );
});
