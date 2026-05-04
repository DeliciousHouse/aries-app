import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, isValidElement } from 'react';

import BrandStep from '../frontend/onboarding/pipeline-intake/steps/BrandStep';
import { BUSINESS_TYPES } from '../frontend/onboarding/pipeline-intake/business-types';

test('BrandStep is a function component', () => {
  assert.equal(typeof BrandStep, 'function');
});

test('BrandStep accepts businessType + onBusinessTypeChange props (createElement contract)', () => {
  const element = createElement(BrandStep, {
    brandUrl: '',
    onBrandUrlChange: () => {},
    businessType: '',
    onBusinessTypeChange: () => {},
    onNext: () => {},
    onBack: () => {},
  });
  assert.ok(isValidElement(element));
  assert.equal(element.type, BrandStep);
  assert.equal(element.props.businessType, '');
  assert.equal(typeof element.props.onBusinessTypeChange, 'function');
});

test('BrandStep accepts a curated business type as businessType', () => {
  const element = createElement(BrandStep, {
    brandUrl: 'https://example.com',
    onBrandUrlChange: () => {},
    businessType: BUSINESS_TYPES[0],
    onBusinessTypeChange: () => {},
    onNext: () => {},
    onBack: () => {},
  });
  assert.ok(isValidElement(element));
  assert.equal(element.props.businessType, BUSINESS_TYPES[0]);
});
