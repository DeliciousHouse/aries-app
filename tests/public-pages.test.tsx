import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import FeaturesPage from '../app/features/page';
import DocumentationPage from '../app/documentation/page';
import ApiDocsPage from '../app/api-docs/page';
import ContactPage from '../app/contact/page';
import { AriesMark } from '../frontend/donor/ui';
import MarketingLayout from '../frontend/marketing/MarketingLayout';
import { ARIES_FAVICON_SVG_PATH, brandLogoPath } from '../lib/brand';

test('AriesMark uses the shared Aries logo asset path', () => {
  const html = renderToStaticMarkup(<AriesMark />);

  assert.equal(brandLogoPath(), ARIES_FAVICON_SVG_PATH);
  assert.match(html, new RegExp(ARIES_FAVICON_SVG_PATH.replace('/', '\\/')));
});

test('Public marketing pages keep using the shared marketing layout', () => {
  const pages = [FeaturesPage(), DocumentationPage(), ApiDocsPage(), ContactPage()];

  for (const element of pages) {
    assert.equal(isValidElement(element), true);
    assert.equal(element.type, MarketingLayout);
  }
});
