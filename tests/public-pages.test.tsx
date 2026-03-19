import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement } from 'react';

import HomePage from '../app/page';
import FeaturesPage from '../app/features/page';
import DocumentationPage from '../app/documentation/page';
import ApiDocsPage from '../app/api-docs/page';
import ContactPage from '../app/contact/page';
import DonorHomePage from '../frontend/donor/marketing/home-page';
import MarketingLayout from '../frontend/marketing/MarketingLayout';

test('Homepage resolves to the donor marketing homepage component', () => {
  const element = HomePage();

  assert.equal(isValidElement(element), true);
  assert.equal(element.type, DonorHomePage);
});

test('Public marketing pages keep using the shared marketing layout', () => {
  const pages = [FeaturesPage(), DocumentationPage(), ApiDocsPage(), ContactPage()];

  for (const element of pages) {
    assert.equal(isValidElement(element), true);
    assert.equal(element.type, MarketingLayout);
  }
});
