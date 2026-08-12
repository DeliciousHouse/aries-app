import assert from 'node:assert/strict';
import test from 'node:test';

import { installJsdom } from './helpers/jsdom-env';

installJsdom();

// React needs this to treat act() as configured; without it every render logs
// "The current testing environment is not configured to support act(...)".
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import {
  useInsight,
  __resetInsightInflightForTests,
  __inflightInsightCountForTests,
} from '../frontend/insights/useInsight';
import type { Period, Platform } from '../frontend/insights/types';

/**
 * AA-123 (S7-5) — BEHAVIOURAL half.
 *
 * The sibling suite pins the source. This one drives the hook for real, because
 * the ticket's actual complaint — "superseded requests still execute
 * server-side" — is a runtime property. A file can contain the words
 * `AbortController` and still never abort anything: that was true of my own
 * first draft, where the effect cleanup bumped a counter and left the request
 * running.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-client-coalescing.behaviour.test.ts
 */

type FetchCall = { url: string; signal: AbortSignal };

/** A fetch that never settles until released — so "in flight" is observable. */
function pendingFetchStub() {
  const calls: FetchCall[] = [];
  const resolvers: Array<(body: unknown) => void> = [];

  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const signal = init?.signal as AbortSignal;
    calls.push({ url, signal });
    return new Promise<Response>((resolve, reject) => {
      resolvers.push((body: unknown) =>
        resolve(new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })),
      );
      // Reject the way the platform does when a request is aborted.
      signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as typeof fetch;

  return { impl, calls, resolveAll: (body: unknown) => resolvers.forEach((r) => r(body)) };
}

async function renderHook(props: { period: Period; platform: Platform; enabled?: boolean }) {
  const { act, create } = await import('react-test-renderer');
  let root: import('react-test-renderer').ReactTestRenderer;

  function Probe({ period, platform, enabled }: typeof props) {
    useInsight<unknown>('trends', period, platform, {}, { enabled });
    return null;
  }

  await act(async () => {
    root = create(React.createElement(Probe, props));
  });
  return {
    rerender: async (next: typeof props) => {
      await act(async () => {
        root.update(React.createElement(Probe, next));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

const originalFetch = globalThis.fetch;
test.beforeEach(() => __resetInsightInflightForTests());
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetInsightInflightForTests();
});

test('changing a filter ABORTS the superseded request, not just its result', async () => {
  // The whole point of the card. Before this, the discarded request ran its
  // aggregate query to completion server-side and the client threw the answer
  // away.
  const stub = pendingFetchStub();
  globalThis.fetch = stub.impl;

  const hook = await renderHook({ period: '90day', platform: 'all' });
  assert.equal(stub.calls.length, 1, 'first render fetches once');
  assert.equal(stub.calls[0].signal.aborted, false);

  await hook.rerender({ period: 'week', platform: 'all' });

  assert.equal(stub.calls[0].signal.aborted, true, 'the superseded request must be aborted');
  assert.equal(stub.calls.length, 2, 'and the new filter fetches');
  assert.equal(stub.calls[1].signal.aborted, false, 'the current request stays alive');

  await hook.unmount();
});

test('unmounting aborts an in-flight request', async () => {
  const stub = pendingFetchStub();
  globalThis.fetch = stub.impl;

  const hook = await renderHook({ period: '90day', platform: 'all' });
  assert.equal(stub.calls.length, 1);

  await hook.unmount();
  assert.equal(stub.calls[0].signal.aborted, true, 'leaving the page must cancel its work');
});

test('a disabled (below-the-fold) section performs NO request', async () => {
  const stub = pendingFetchStub();
  globalThis.fetch = stub.impl;

  const hook = await renderHook({ period: '90day', platform: 'all', enabled: false });
  assert.equal(stub.calls.length, 0, 'a deferred section must not fetch');

  // Scrolled into view → now it fetches, with the CURRENT filter.
  await hook.rerender({ period: 'week', platform: 'all', enabled: true });
  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0].url, /period=week/, 'it picks up the filter it was given');

  await hook.unmount();
});

test('two components wanting the same data share ONE request', async () => {
  const stub = pendingFetchStub();
  globalThis.fetch = stub.impl;

  const a = await renderHook({ period: '90day', platform: 'all' });
  const b = await renderHook({ period: '90day', platform: 'all' });

  assert.equal(stub.calls.length, 1, 'the second consumer joins the in-flight request');
  assert.equal(__inflightInsightCountForTests(), 1);

  // One leaving must NOT cancel the request the other is still waiting on.
  await a.unmount();
  assert.equal(stub.calls[0].signal.aborted, false, 'the survivor keeps its request');

  await b.unmount();
  assert.equal(stub.calls[0].signal.aborted, true, 'the last consumer leaving aborts it');
});

test('an aborted request leaves no error on screen', async () => {
  // Without the AbortError guard, every filter toggle would flash a failure.
  const stub = pendingFetchStub();
  globalThis.fetch = stub.impl;

  const seen: Array<string | null> = [];
  function Probe({ period }: { period: Period }) {
    const { error } = useInsight<unknown>('trends', period, 'all');
    seen.push(error);
    return null;
  }

  const { act, create } = await import('react-test-renderer');
  let root: import('react-test-renderer').ReactTestRenderer;
  await act(async () => {
    root = create(React.createElement(Probe, { period: '90day' as Period }));
  });
  await act(async () => {
    root.update(React.createElement(Probe, { period: 'week' as Period }));
  });
  // Let the aborted promise reject and any handler run.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  assert.ok(
    seen.every((e) => e === null),
    `an abort must never surface as an error; saw ${JSON.stringify(seen)}`,
  );
  await act(async () => root.unmount());
});
