import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  COMPETITOR_URL_INVALID_ERROR,
  COMPETITOR_URL_SOCIAL_ERROR,
  validateCanonicalCompetitorUrl,
} from '../lib/marketing-competitor';
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
    /const competitorValidation = validateCanonicalCompetitorUrl\(values\.competitorUrl \?\? ''\);[\s\S]*?if \(competitorValidation\.error\) \{[\s\S]*?return false;/,
    'step-one validity should block Continue when the optional competitor URL fails canonical validation',
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

test('onboarding step one uses canonical competitor validation for inline errors before Continue', () => {
  assert.match(
    source,
    /validateCanonicalCompetitorUrl\(competitorUrl\)/,
    'step-one competitor input should use the same canonical validator as final submit',
  );
  assert.match(
    source,
    /const competitorUrlFieldError = competitorUrlError && \(touched\.competitorUrl \|\| currentStep\.key === 'goal'\)/,
    'competitor URL errors should render inline while the step-one field is present',
  );
  assert.match(
    source,
    /Do not paste Facebook, Instagram, or Meta Ad Library URLs\./,
    'the competitor field should warn against Meta locator URLs at entry time',
  );
  assert.match(
    source,
    /stepValidationMessage\(currentStep\.key, \{ businessName, businessType, goal, offer, competitorUrl \}\)/,
    'Continue should surface canonical competitor validation messages instead of deferring to final submit',
  );
});

test('canonical competitor validation rejects Facebook, Meta Ad Library, and unsupported step-one entries', () => {
  assert.equal(
    validateCanonicalCompetitorUrl('https://www.facebook.com/betterupco').error,
    COMPETITOR_URL_SOCIAL_ERROR,
  );
  assert.equal(
    validateCanonicalCompetitorUrl('https://www.facebook.com/ads/library/?id=123').error,
    COMPETITOR_URL_SOCIAL_ERROR,
  );
  assert.equal(
    validateCanonicalCompetitorUrl('http://competitor.example').error,
    COMPETITOR_URL_INVALID_ERROR,
  );
});
