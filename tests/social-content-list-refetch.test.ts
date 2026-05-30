import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';

import { useRuntimePosts } from '../hooks/use-runtime-social-content';

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const LIST_PATH = '/api/social-content/posts';

function listBody() {
  return JSON.stringify({ posts: [], deletedPosts: [], currentBrandKitExtractedAt: null });
}

// Fetch stub that resolves the list endpoint immediately and counts hits.
function installCountingFetch() {
  const previous = globalThis.fetch;
  const counts = { list: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, 'https://aries.example.com').pathname;
    if (path === LIST_PATH) {
      counts.list += 1;
      return new Response(listBody(), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch in social-content list refetch test: ${path}`);
  }) as typeof fetch;
  return { counts, restore: () => { globalThis.fetch = previous; } };
}

// Fetch stub whose list responses stay pending until resolveAll() is called.
// Lets us assert dedupe DURING the in-flight window without timing races.
function installControllableFetch() {
  const previous = globalThis.fetch;
  const counts = { list: 0 };
  let resolvers: Array<() => void> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, 'https://aries.example.com').pathname;
    if (path === LIST_PATH) {
      counts.list += 1;
      return await new Promise<Response>((res) => {
        resolvers.push(() =>
          res(new Response(listBody(), { status: 200, headers: { 'content-type': 'application/json' } })),
        );
      });
    }
    throw new Error(`Unexpected fetch in social-content list refetch test: ${path}`);
  }) as typeof fetch;
  return {
    counts,
    resolveAll: () => {
      const pending = resolvers;
      resolvers = [];
      pending.forEach((fn) => fn());
    },
    restore: () => { globalThis.fetch = previous; },
  };
}

function Child() {
  useRuntimePosts({ autoLoad: true });
  return React.createElement('div', null, 'list');
}

test('social-content list auto-load fires once under StrictMode double-invoke', async () => {
  const f = installCountingFetch();
  try {
    const { act, create } = await import('react-test-renderer');
    await act(async () => {
      create(React.createElement(React.StrictMode, null, React.createElement(Child)));
      for (let i = 0; i < 10; i++) await flush();
    });
    assert.equal(f.counts.list, 1);
  } finally {
    f.restore();
  }
});

test('social-content list dedupes a genuine remount storm during a slow in-flight load', async () => {
  const f = installControllableFetch();
  try {
    const { act, create } = await import('react-test-renderer');
    let root: import('react-test-renderer').ReactTestRenderer | null = null;
    // First mount kicks off the (still-pending) list fetch.
    await act(async () => {
      root = create(React.createElement('div', null, React.createElement(Child, { key: 'm0' })));
      await flush();
    });
    // Force four more GENUINE remounts (changing key) while the first fetch
    // is still in flight. Without a module-scoped dedupe each remount would
    // issue its own request; with it, all reuse the single pending promise.
    for (let i = 1; i <= 4; i++) {
      await act(async () => {
        root!.update(React.createElement('div', null, React.createElement(Child, { key: `m${i}` })));
        await flush();
      });
    }
    assert.equal(f.counts.list, 1, `expected 1 list fetch across the remount storm, got ${f.counts.list}`);
    // Drain the in-flight promise so the module-scoped slot clears for later tests.
    await act(async () => {
      f.resolveAll();
      for (let i = 0; i < 5; i++) await flush();
    });
  } finally {
    f.restore();
  }
});

test('a forced refresh after a settled load still hits the network', async () => {
  const f = installCountingFetch();
  try {
    let api: ReturnType<typeof useRuntimePosts> | null = null;
    function Harness() {
      api = useRuntimePosts({ autoLoad: true });
      return React.createElement('div', null, 'h');
    }
    const { act, create } = await import('react-test-renderer');
    await act(async () => {
      create(React.createElement(Harness));
      for (let i = 0; i < 5; i++) await flush();
    });
    assert.equal(f.counts.list, 1); // auto-load
    await act(async () => {
      await api!.load({ force: true }); // refresh-on-action (delete/restore) path
      for (let i = 0; i < 5; i++) await flush();
    });
    assert.equal(f.counts.list, 2); // forced refresh re-hit the network
  } finally {
    f.restore();
  }
});
