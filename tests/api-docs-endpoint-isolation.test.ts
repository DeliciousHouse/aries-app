import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

import ApiDocsPage from '../app/api-docs/page';

type AnyElement = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;

function* walk(node: ReactNode): Generator<AnyElement> {
  if (node == null || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as AnyElement;
  yield el;
  const children = (el.props as { children?: ReactNode } | undefined)?.children;
  if (children !== undefined) yield* walk(children);
}

function findAll(root: ReactNode, predicate: (el: AnyElement) => boolean): AnyElement[] {
  const found: AnyElement[] = [];
  for (const el of walk(root)) {
    if (predicate(el)) found.push(el);
  }
  return found;
}

function textContent(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode })?.children;
    return textContent(children);
  }
  return '';
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

test('ISSUE-W2-M6 — each /api-docs endpoint is an isolated block with its own method badge', () => {
  const tree = ApiDocsPage();
  assert.equal(isValidElement(tree), true);

  const endpoints = findAll(
    tree,
    (el) =>
      (el.props as Record<string, unknown>)['data-testid'] === 'api-docs-endpoint',
  );
  assert.ok(endpoints.length >= 8, `expected >=8 endpoints, got ${endpoints.length}`);

  for (const endpoint of endpoints) {
    const methodBadges = findAll(
      endpoint,
      (el) =>
        (el.props as Record<string, unknown>)['data-testid'] ===
        'api-docs-endpoint-method',
    );
    assert.equal(
      methodBadges.length,
      1,
      'each endpoint must contain exactly one method badge',
    );
    const methodText = textContent(methodBadges[0]).trim();
    assert.ok(
      METHODS.has(methodText),
      `method badge should be an HTTP verb, got ${JSON.stringify(methodText)}`,
    );

    const responses = findAll(
      endpoint,
      (el) =>
        (el.props as Record<string, unknown>)['data-testid'] ===
        'api-docs-endpoint-response',
    );
    assert.equal(
      responses.length,
      1,
      'each endpoint must contain exactly one response block',
    );
    const responseText = textContent(responses[0]);
    // The method badge of the NEXT endpoint must not bleed into this endpoint's response.
    for (const verb of METHODS) {
      assert.ok(
        !responseText.trimEnd().endsWith(verb),
        `response for endpoint should not end with a bare HTTP verb (${verb}): ${responseText}`,
      );
    }
  }
});

test('ISSUE-W2-M6 — api-docs endpoints render inside a single <ul> list, method first in each <article>', () => {
  const tree = ApiDocsPage();
  const lists = findAll(
    tree,
    (el) =>
      (el.props as Record<string, unknown>)['data-testid'] ===
      'api-docs-endpoint-list',
  );
  assert.equal(lists.length, 1, 'expected a single endpoint list container');
  assert.equal(lists[0].type, 'ul');

  const articles = findAll(tree, (el) => el.type === 'article');
  assert.ok(articles.length >= 8);
  for (const article of articles) {
    // First descendant carrying the method data-testid must exist and be reached
    // before any response-block descendant — i.e. the badge lives inside the article,
    // not as a sibling leaking into another block.
    let sawMethod = false;
    let sawResponse = false;
    let methodBeforeResponse = false;
    for (const el of walk(article)) {
      const testid = (el.props as Record<string, unknown>)['data-testid'];
      if (testid === 'api-docs-endpoint-method') {
        sawMethod = true;
        if (!sawResponse) methodBeforeResponse = true;
      }
      if (testid === 'api-docs-endpoint-response') {
        sawResponse = true;
      }
    }
    assert.ok(sawMethod, 'article must contain its own method badge');
    assert.ok(sawResponse, 'article must contain its own response block');
    assert.ok(
      methodBeforeResponse,
      'method badge must precede response block inside the same article',
    );
  }
});
