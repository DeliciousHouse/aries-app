import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';

// Verifies the Story/Feed toggle in the per-post publish drawers actually
// threads `placement` into the POST body sent to the per-job publish endpoint.
// This is the user-visible half of image Stories: clicking "Story" must send
// placement=story; leaving the default must send placement=feed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type DrawerCase = {
  label: string;
  importPath: string;
  prefix: 'ig' | 'fb';
};

const CASES: DrawerCase[] = [
  { label: 'Instagram', importPath: '../frontend/aries-v1/instagram-publish-drawer', prefix: 'ig' },
  { label: 'Facebook', importPath: '../frontend/aries-v1/facebook-publish-drawer', prefix: 'fb' },
];

async function renderAndSubmit(
  drawerCase: DrawerCase,
  clickStory: boolean,
): Promise<Record<string, unknown> | null> {
  const previousFetch = globalThis.fetch;
  // The drawers register a keydown listener on window for Escape-to-close.
  // react-test-renderer has no DOM, so provide a minimal window stub.
  const globalRef = globalThis as Record<string, unknown>;
  const previousWindow = globalRef.window;
  if (!previousWindow) {
    globalRef.window = { addEventListener() {}, removeEventListener() {} };
  }
  let capturedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    return new Response(
      JSON.stringify({ status: 'published', platform_post_id: 'post_1', permalink: null }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const { act, create } = await import('react-test-renderer');
    const Drawer = (await import(drawerCase.importPath)).default as React.ComponentType<{
      jobId: string;
      defaultCaption?: string;
      onClose: () => void;
    }>;

    let root!: import('react-test-renderer').ReactTestRenderer;
    await act(async () => {
      root = create(
        React.createElement(Drawer, { jobId: 'job_1', defaultCaption: 'hi', onClose: () => {} }),
      );
    });

    if (clickStory) {
      const storyToggle = root.root.find(
        (node) => node.props?.['data-testid'] === `${drawerCase.prefix}-publish-placement-story`,
      );
      await act(async () => {
        storyToggle.props.onClick();
      });
    }

    const form = root.root.findByType('form');
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
    });

    return capturedBody;
  } finally {
    globalThis.fetch = previousFetch;
    globalRef.window = previousWindow;
  }
}

for (const drawerCase of CASES) {
  test(`${drawerCase.label} drawer sends placement=story when the Story toggle is selected`, async () => {
    const body = await renderAndSubmit(drawerCase, true);
    assert.ok(body, 'a publish request must have been sent');
    assert.equal(body?.placement, 'story', 'selecting Story must send placement=story');
  });

  test(`${drawerCase.label} drawer defaults placement=feed when the toggle is untouched`, async () => {
    const body = await renderAndSubmit(drawerCase, false);
    assert.ok(body, 'a publish request must have been sent');
    assert.equal(body?.placement, 'feed', 'the default must be a feed post, never a story');
  });
}
