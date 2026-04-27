import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readProjectFile(...segments: string[]): string {
  return readFileSync(path.join(PROJECT_ROOT, ...segments), 'utf8');
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function navOpeningTags(source: string): string[] {
  return source.match(/<nav\b[\s\S]*?>/g) ?? [];
}

function assertNavsAreNamed(source: string, context: string): void {
  const navs = navOpeningTags(source);

  assert.notEqual(navs.length, 0, `${context} should render at least one nav landmark`);
  assert.deepEqual(
    navs.filter((nav) => !/\baria-(?:label|labelledby)=/.test(nav)),
    [],
    `${context} should give every nav landmark an accessible name`,
  );
}

// ISSUE-003 — public navigation should point at the standalone /features page,
// and pages composed with shared shells should expose a single primary main landmark.
test('public marketing Features links use the canonical /features route', () => {
  const chromeSource = readProjectFile('frontend', 'donor', 'marketing', 'chrome.tsx');

  assert.ok(
    existsSync(path.join(PROJECT_ROOT, 'app', 'features', 'page.tsx')),
    'canonical /features route should exist',
  );
  assert.match(
    chromeSource,
    /\{ name: 'Features', href: '\/features' \}/,
    'global navigation should send Features to /features',
  );
  assert.match(
    chromeSource,
    /<a href="\/features" className="hover:text-white transition-colors">Features<\/a>/,
    'footer Features link should send Features to /features',
  );
  assert.doesNotMatch(
    chromeSource,
    /href[:=]\s*["']\/#features["']/,
    'public chrome should not link Features to the retired homepage #features anchor',
  );
});

test('auth layout contributes exactly one primary main landmark', () => {
  const authLayoutSource = readProjectFile('frontend', 'auth', 'auth-layout.tsx');

  assert.equal(countMatches(authLayoutSource, /<main\b/g), 1);
  assert.equal(countMatches(authLayoutSource, /<\/main>/g), 1);
  assert.equal(countMatches(authLayoutSource, /\brole=["']main["']/g), 0);
});

test('documentation content does not nest a second main inside the marketing shell', () => {
  const docsSource = readProjectFile('frontend', 'documentation', 'Docs.tsx');
  const marketingShellSource = readProjectFile('frontend', 'donor', 'marketing', 'chrome.tsx');
  const documentationPageSource = readProjectFile('app', 'documentation', 'page.tsx');

  assert.match(documentationPageSource, /<MarketingLayout>[\s\S]*<Docs \/>[\s\S]*<\/MarketingLayout>/);
  assert.equal(countMatches(marketingShellSource, /<main\b/g), 1, 'marketing shell should own the page main landmark');
  assert.equal(countMatches(docsSource, /<main\b/g), 0, 'Docs content should not render a nested main landmark');
  assert.equal(countMatches(docsSource, /\brole=["']main["']/g), 0, 'Docs content should not add a role=main landmark');
});

test('documentation page labels marketing and section navigation landmarks', () => {
  const docsSource = readProjectFile('frontend', 'documentation', 'Docs.tsx');
  const marketingShellSource = readProjectFile('frontend', 'donor', 'marketing', 'chrome.tsx');
  const documentationPageSource = readProjectFile('app', 'documentation', 'page.tsx');

  assert.match(documentationPageSource, /<MarketingLayout>[\s\S]*<Docs \/>[\s\S]*<\/MarketingLayout>/);
  assertNavsAreNamed(marketingShellSource, 'marketing shell');
  assertNavsAreNamed(docsSource, 'documentation sections');
  assert.match(
    navOpeningTags(marketingShellSource).join('\n'),
    /\baria-label="Primary"/,
    'global marketing navigation should be named Primary',
  );
  assert.match(
    navOpeningTags(docsSource).join('\n'),
    /\baria-label="Documentation sections"/,
    'Docs sidebar navigation should be named Documentation sections',
  );
});
