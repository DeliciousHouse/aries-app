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
    assert.match(homeSource, /Start Automating/);
    assert.match(homeSource, /See Runtime/);
    assert.match(homeSource, /DonorMarketingShell heroMode/);

    const featuresElement = FeaturesPage();
    assert.equal(isValidElement(featuresElement), true);
    assert.equal(featuresElement.type, MarketingLayout);
    const featuresText = normalizeWhitespace(collectText(featuresElement.props.children));
    assert.match(featuresText, /The current Aries runtime is a direct operator surface/);
    assert.match(featuresText, /Ready to verify the runtime end to end\?/);
    assert.match(featuresText, /Read the docs/);

    const documentationElement = DocumentationPage();
    assert.equal(isValidElement(documentationElement), true);
    assert.equal(documentationElement.type, MarketingLayout);
    const documentationText = normalizeWhitespace(collectText(documentationElement.props.children));
    assert.match(documentationText, /Direct architecture/);
    assert.match(documentationText, /Execution boundary/);
    assert.match(documentationText, /npx next dev -p 3000 --turbopack/);
    assert.match(documentationText, /Commands engineers should run before shipping docs changes/);

    const contactElement = ContactPage();
    assert.equal(isValidElement(contactElement), true);
    assert.equal(contactElement.type, MarketingLayout);
    const contactText = normalizeWhitespace(collectText(contactElement.props.children));
    assert.match(contactText, /No contact workflow is deployed/);
    assert.match(contactText, /\/api\/contact/);
    assert.match(contactText, /Review the API/);

    const apiDocsElement = ApiDocsPage();
    assert.equal(isValidElement(apiDocsElement), true);
    assert.equal(apiDocsElement.type, MarketingLayout);
    const apiDocsText = normalizeWhitespace(collectText(apiDocsElement.props.children));
    assert.match(apiDocsText, /\/api\/contact/);
    assert.match(apiDocsText, /\/api\/marketing\/jobs/);
    assert.match(apiDocsText, /Browser-safe routes for the current Aries contract/);
  });
});

test('DonorNavbar toggles the mobile menu, renders mobile nav links, and keeps the primary CTA available', async () => {
  const g = globalThis as any;
  const prevSelf = g.self;
  const prevWindow = g.window;

  g.self = globalThis;
  g.window = {
    scrollY: 0,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
  };

  const nextLink = require('next/link');
  const originalLink = nextLink.default;
  nextLink.default = function MockLink(props: { href?: string; children?: ReactNode } & Record<string, unknown>) {
    const href = typeof props.href === 'string' ? props.href : String(props.href ?? '');
    return React.createElement('a', { ...props, href }, props.children);
  };

  try {
    await withReactGlobal(async () => {
      const { act, create } = await import('react-test-renderer');
      const { DonorNavbar } = await import('../frontend/donor/marketing/chrome');

      let root: import('react-test-renderer').ReactTestRenderer | null = null;
      await act(async () => {
        root = create(React.createElement(DonorNavbar, { heroMode: false }));
      });

      const getRoot = () => {
        assert.ok(root);
        return root;
      };

      const countAnchors = (href: string) =>
        getRoot().root.findAll(
          (node: import('react-test-renderer').ReactTestInstance) =>
            node.type === 'a'
            && typeof node.props.href === 'string'
            && node.props.href === href,
        ).length;

      const menuButton = () => getRoot().root.findByType('button');

      assert.equal(menuButton().props['aria-label'], 'Open menu');
      assert.equal(countAnchors('/documentation'), 1);
      assert.equal(countAnchors('/login'), 1);

      await act(async () => {
        menuButton().props.onClick();
      });

      assert.equal(menuButton().props['aria-label'], 'Close menu');
      assert.equal(countAnchors('/documentation'), 2);
      assert.equal(countAnchors('/login'), 2);

      const renderedAnchorText = getRoot().root
        .findAllByType('a')
        .map((anchor: import('react-test-renderer').ReactTestInstance) => normalizeWhitespace(collectText(anchor.props.children)))
        .filter(Boolean);

      assert.ok(renderedAnchorText.includes('Docs'));
      assert.ok(renderedAnchorText.includes('How it Works'));
      assert.ok(renderedAnchorText.includes('Features'));
      assert.ok(renderedAnchorText.includes('Pricing'));
      assert.ok(renderedAnchorText.includes('Start Automating'));

      await act(async () => {
        menuButton().props.onClick();
      });

      assert.equal(menuButton().props['aria-label'], 'Open menu');
    });
  } finally {
    nextLink.default = originalLink;
    if (prevSelf === undefined) { delete g.self; } else { g.self = prevSelf; }
    if (prevWindow === undefined) { delete g.window; } else { g.window = prevWindow; }
  }
});

test('public marketing pages use direct document navigation for public links', () => {
  const chromeSource = readRepoFile('frontend/donor/marketing/chrome.tsx');
  const homeSource = readRepoFile('frontend/donor/marketing/home-page.tsx');
  const sitemapSource = readRepoFile('app/sitemap/page.tsx');

  assert.doesNotMatch(chromeSource, /import Link from 'next\/link'/);
  assert.doesNotMatch(homeSource, /import Link from 'next\/link'/);
  assert.doesNotMatch(sitemapSource, /import Link from 'next\/link'/);

  assert.match(chromeSource, /href="\/terms"/);
  assert.match(chromeSource, /href="\/privacy"/);
  assert.match(chromeSource, /href="\/sitemap"/);
});
