import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import React, { isValidElement, type ReactNode } from 'react';

import HomePage from '../app/page';
import FeaturesPage from '../app/features/page';
import DocumentationPage from '../app/documentation/page';
import ContactPage from '../app/contact/page';
import ApiDocsPage from '../app/api-docs/page';
import DonorHomePage from '../frontend/donor/marketing/home-page';
import MarketingLayout from '../frontend/marketing/MarketingLayout';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readRepoFile(relativePath: string) {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(' ');
  }

  if (isValidElement(node)) {
    return collectText(node.props.children);
  }

  return '';
}

async function withReactGlobal<T>(fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const prevReact = g.React;
  g.React = React;
  try {
    return await Promise.resolve(fn());
  } finally {
    if (prevReact === undefined) {
      delete g.React;
    } else {
      g.React = prevReact;
    }
  }
}

test('public marketing pages return valid elements with expected route shells and stable content markers', async () => {
  await withReactGlobal(() => {
    const homeElement = HomePage();
    assert.equal(isValidElement(homeElement), true);
    assert.equal(homeElement.type, DonorHomePage);

    const homeSource = readRepoFile('frontend/donor/marketing/home-page.tsx');
    assert.match(homeSource, /Nothing goes live without your approval/);
    assert.match(homeSource, /Plan, create, approve, launch, and/);
    assert.match(homeSource, /Start with your business/);
    assert.doesNotMatch(homeSource, /Autonomous Growth Engine/);
    assert.doesNotMatch(homeSource, /Start Automating/);
    assert.doesNotMatch(homeSource, /See Runtime/);

    const featuresElement = FeaturesPage();
    assert.equal(isValidElement(featuresElement), true);
    assert.equal(featuresElement.type, MarketingLayout);
    const featuresText = normalizeWhitespace(collectText(featuresElement.props.children));
    assert.match(featuresText, /market with confidence/);
    assert.match(featuresText, /Ready to see how it works\?/);
    assert.match(featuresText, /Start with your business/);

    const documentationElement = DocumentationPage();
    assert.equal(isValidElement(documentationElement), true);
    assert.equal(documentationElement.type, MarketingLayout);

    const contactElement = ContactPage();
    assert.equal(isValidElement(contactElement), true);
    assert.equal(contactElement.type, MarketingLayout);
    const contactText = normalizeWhitespace(collectText(contactElement.props.children));
    assert.match(contactText, /Contact intake is not available yet/);
    assert.match(contactText, /Start with your business/);

    const apiDocsElement = ApiDocsPage();
    assert.equal(isValidElement(apiDocsElement), true);
    assert.equal(apiDocsElement.type, MarketingLayout);
    const apiDocsText = normalizeWhitespace(collectText(apiDocsElement.props.children));
    assert.match(apiDocsText, /\/api\/contact/);
    assert.match(apiDocsText, /\/api\/marketing\/jobs/);
    assert.match(apiDocsText, /Browser-safe routes for the current Aries contract/);
  });
});

test('the authenticated route registry uses the required v1 top navigation labels', () => {
  const routeSource = readRepoFile('frontend/app-shell/routes.ts');

  assert.match(routeSource, /title:\s*'Home'/);
  assert.match(routeSource, /title:\s*'Campaigns'/);
  assert.match(routeSource, /title:\s*'Calendar'/);
  assert.match(routeSource, /title:\s*'Results'/);
  assert.match(routeSource, /href:\s*'\/campaigns'/);
  assert.match(routeSource, /href:\s*'\/results'/);
});
