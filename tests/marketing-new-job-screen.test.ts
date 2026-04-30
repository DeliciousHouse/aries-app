import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';

import { MarketingNewJobScreenContent, normalizeWebsiteUrlInput } from '../frontend/marketing/new-job';

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('MarketingNewJobScreen shows the backend error after a valid submit fails', async () => {
  const globalWithWindow = globalThis as Record<string, unknown>;
  const previousFetch = globalThis.fetch;
  const previousWindow = globalWithWindow.window;
  const pushCalls: string[] = [];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'OpenClaw gateway unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  globalWithWindow.window = globalThis;

  try {
    const { act, create } = await import('react-test-renderer');
    let root!: import('react-test-renderer').ReactTestRenderer;

    await act(async () => {
      root = create(
        React.createElement(MarketingNewJobScreenContent, {
          embedded: true,
          redirectMode: 'dashboard',
          router: {
            push(href: string) {
              pushCalls.push(href);
            },
          },
        }),
      );
      await flushMicrotasks();
    });

    const websiteInput = root.root.findByProps({ placeholder: 'https://yourbrand.com' });
    await act(async () => {
      websiteInput.props.onChange({ target: { value: 'https://example.com' } });
      await flushMicrotasks();
    });

    const form = root.root.findByType('form');
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    assert.deepEqual(pushCalls, []);
    assert.match(JSON.stringify(root.toJSON()), /OpenClaw gateway unavailable/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = previousWindow;
    }
  }
});


test('MarketingNewJobScreen normalizes bare website domains to HTTPS', () => {
  assert.equal(normalizeWebsiteUrlInput('example.com'), 'https://example.com');
  assert.equal(normalizeWebsiteUrlInput(' https://example.com '), 'https://example.com');
});
