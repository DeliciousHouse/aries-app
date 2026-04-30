import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';

import {
  normalizeHttpsUrlInput,
  stepReady,
  stepValidationMessage,
} from '../frontend/aries-v1/onboarding-flow';
import { useDisabledUntilValid } from '../lib/form-validation';
import {
  COMPETITOR_URL_INVALID_ERROR,
  COMPETITOR_URL_SOCIAL_ERROR,
  validateCanonicalCompetitorUrl,
} from '../lib/marketing-competitor';

type GoalStepValues = Parameters<typeof stepReady>[1];

const validGoalValues: GoalStepValues = {
  businessName: '',
  businessType: '',
  websiteUrl: '',
  selectedChannels: [],
  goal: 'Get leads',
  customGoal: '',
  offer: 'Lifecycle email automation for growing ecommerce brands.',
  competitorUrl: '',
};

function goalValues(overrides: Partial<GoalStepValues>): GoalStepValues {
  return { ...validGoalValues, ...overrides };
}

test('onboarding goal step behavior gates Continue until goal, offer, and canonical competitor URL are valid', () => {
  assert.equal(
    stepReady('goal', goalValues({ goal: '' })),
    false,
    'goal step is not ready until an outcome is selected',
  );
  assert.equal(
    stepValidationMessage('goal', goalValues({ goal: '' })),
    'Choose a business outcome before continuing.',
  );

  assert.equal(
    stepReady('goal', goalValues({ offer: '   ' })),
    false,
    'goal step is not ready until the offer is described',
  );
  assert.equal(
    stepValidationMessage('goal', goalValues({ offer: '   ' })),
    'Describe what your business offers before continuing.',
  );

  assert.equal(
    stepReady('goal', goalValues({ competitorUrl: 'https://www.facebook.com/betterupco' })),
    false,
    'Meta/Facebook locator URLs must block Continue on the competitor field step',
  );
  assert.equal(
    stepValidationMessage('goal', goalValues({ competitorUrl: 'https://www.facebook.com/betterupco' })),
    COMPETITOR_URL_SOCIAL_ERROR,
  );

  assert.equal(
    stepReady('goal', goalValues({ competitorUrl: 'http://competitor.example' })),
    false,
    'non-HTTPS competitor URLs must block Continue on the competitor field step',
  );
  assert.equal(
    stepValidationMessage('goal', goalValues({ competitorUrl: 'http://competitor.example' })),
    COMPETITOR_URL_INVALID_ERROR,
  );

  assert.equal(
    stepReady('goal', goalValues({ competitorUrl: 'competitor.example' })),
    true,
    'a valid canonical competitor website keeps the goal step ready',
  );
  assert.equal(
    stepValidationMessage('goal', goalValues({ competitorUrl: 'competitor.example' })),
    null,
  );
  assert.deepEqual(validateCanonicalCompetitorUrl('competitor.example'), {
    normalized: 'https://competitor.example/',
    error: null,
  });
});

test('shared disabled helper keeps Continue disabled for invalid or busy onboarding goal state', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  function ContinueHarness(props: { values: GoalStepValues; busy?: boolean }) {
    const disabled = useDisabledUntilValid(stepReady('goal', props.values), props.busy ?? false);
    return React.createElement('button', { disabled }, 'Continue');
  }

  await act(async () => {
    root = create(
      React.createElement(ContinueHarness, {
        values: goalValues({ competitorUrl: 'https://www.instagram.com/competitor' }),
      }),
    );
  });
  assert.equal(root.root.findByType('button').props.disabled, true);

  await act(async () => {
    root.update(
      React.createElement(ContinueHarness, {
        values: goalValues({ competitorUrl: 'https://competitor.example' }),
      }),
    );
  });
  assert.equal(root.root.findByType('button').props.disabled, false);

  await act(async () => {
    root.update(
      React.createElement(ContinueHarness, {
        values: goalValues({ competitorUrl: 'https://competitor.example' }),
        busy: true,
      }),
    );
  });
  assert.equal(root.root.findByType('button').props.disabled, true);
});


test('onboarding website step accepts bare domains by normalizing to HTTPS', () => {
  assert.equal(normalizeHttpsUrlInput('example.com'), 'https://example.com');
  assert.equal(normalizeHttpsUrlInput(' https://example.com/path '), 'https://example.com/path');
  assert.equal(
    stepReady('website', {
      businessName: '',
      businessType: '',
      websiteUrl: 'example.com',
      selectedChannels: [],
      goal: '',
      customGoal: '',
      offer: '',
    }),
    true,
  );
});
