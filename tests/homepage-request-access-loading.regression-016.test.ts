import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function textContent(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join('');
  }
  if (!node || typeof node !== 'object') {
    return '';
  }
  const props = (node as { props?: { children?: unknown } }).props;
  return textContent(props?.children);
}

test('request-access form does not flip to validation error on a second submit while loading', async () => {
  const previousFetch = globalThis.fetch;
  let resolveFetch: ((value: Response) => void) | null = null;
  let fetchCalls = 0;

  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return await new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
  }) as typeof fetch;

  try {
    const { act, create } = await import('react-test-renderer');
    const { EarlyAccessForm } = await import('../frontend/donor/marketing/home-page');

    let root!: import('react-test-renderer').ReactTestRenderer;
    await act(async () => {
      root = create(
        React.createElement(EarlyAccessForm, {
          source: 'test',
          emailInputId: 'test-email',
        }),
      );
    });

    const input = root.root.findByType('input');
    await act(async () => {
      input.props.onChange({ target: { value: 'founder@example.com' } });
    });

    const form = root.root.findByType('form');
    await act(async () => {
      const submitEvent = { preventDefault() {} };
      const firstSubmit = form.props.onSubmit(submitEvent);
      form.props.onSubmit(submitEvent);
      await flushMicrotasks();
      assert.equal(fetchCalls, 1);
      assert.equal(root.root.findByType('button').props.disabled, true);
      assert.equal(
        root.root.findAll((node) => node.props?.role === 'alert').length,
        0,
      );
      resolveFetch?.(
        new Response(JSON.stringify({ message: "You're on the early access list." }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await firstSubmit;
      await flushMicrotasks();
    });

    const alertTexts = root.root
      .findAll((node) => node.props?.role === 'alert')
      .map((node) => textContent(node.props.children));
    assert.equal(alertTexts.some((text) => text.includes('Enter a valid email address.')), false);
    const paragraphs = root.root.findAllByType('p').map((node) => textContent(node.props.children));
    assert.equal(paragraphs.some((text) => text.includes("You're on the early access list.")), true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
