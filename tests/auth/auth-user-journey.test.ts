import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolvePostLoginDestination,
  shouldRequireOnboarding,
} from '../../lib/auth-user-journey';

test('requires onboarding for newly registered users who have not completed it', () => {
  assert.equal(
    shouldRequireOnboarding({
      onboardingRequired: true,
      onboardingCompletedAt: null,
      onboardingCompleted: false,
    }),
    true,
  );
});

test('skips onboarding for existing users even when the tenant profile is incomplete', () => {
  assert.equal(
    shouldRequireOnboarding({
      onboardingRequired: false,
      onboardingCompletedAt: null,
      onboardingCompleted: false,
    }),
    false,
  );
});

test('stops requiring onboarding after completion is recorded', () => {
  assert.equal(
    shouldRequireOnboarding({
      onboardingRequired: true,
      onboardingCompletedAt: '2026-04-08T10:00:00.000Z',
      onboardingCompleted: true,
    }),
    false,
  );
});

test('redirects users who still need onboarding back to onboarding', () => {
  assert.equal(resolvePostLoginDestination(true), '/onboarding/pipeline-intake');
});

test('redirects users who do not need onboarding to the dashboard', () => {
  assert.equal(resolvePostLoginDestination(false), '/dashboard');
});
