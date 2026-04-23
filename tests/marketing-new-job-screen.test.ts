import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';

import { MarketingNewJobScreenContent } from '../frontend/marketing/new-job';

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('MarketingNewJobScreen shows the backend error after a valid submit fails', async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as typeof globalThis & { window?: typeof globalThis }).window;
  const pushCalls: string[] = [];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'OpenClaw gateway unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  (globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;

  try {
    const { act, create } = await import('react-test-renderer');
    let root: import('react-test-renderer').ReactTestRenderer | null = null;

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

    const renderer = root;
    assert.ok(renderer, 'renderer should be created');

    const websiteInput = renderer.root.findByProps({ placeholder: 'https://yourbrand.com' });
    await act(async () => {
      websiteInput.props.onChange({ target: { value: 'https://example.com' } });
      await flushMicrotasks();
    });

    const form = renderer.root.findByType('form');
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    assert.deepEqual(pushCalls, []);
    assert.match(JSON.stringify(renderer.toJSON()), /OpenClaw gateway unavailable/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) {
      delete (globalThis as typeof globalThis & { window?: typeof globalThis }).window;
    } else {
      (globalThis as typeof globalThis & { window: typeof globalThis }).window = previousWindow;
    }
  }
});
