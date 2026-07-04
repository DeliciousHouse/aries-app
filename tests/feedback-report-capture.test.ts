import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import React from 'react';

/**
 * Regression coverage for AA-77 ("Capture Screen feedback button captures
 * incorrect portion of the screen"). The fix replaced the getDisplayMedia
 * screen-SHARE path (picker friction, whole-surface capture, no mobile support)
 * with an in-page DOM rasterization that excludes the feedback UI. These tests
 * pin:
 *   1. the node filter that keeps the page but drops the feedback chrome,
 *   2. the capture helper's contract (JPEG data URL, fail-open to null),
 *   3. that the rendered dialog offers the capture button and marks the modal
 *      root as capture-ignored — and that the dialog no longer touches
 *      getDisplayMedia at all.
 */

import {
  CAPTURE_IGNORE_ATTR,
  CAPTURE_JPEG_QUALITY,
  capturePageScreenshot,
  pageCaptureSupported,
  shouldCaptureNode,
} from '../frontend/feedback/capture-screenshot';

// ── shouldCaptureNode (pure) ───────────────────────────────────────────────

test('shouldCaptureNode keeps a normal element (not inside the feedback UI)', () => {
  const el = { nodeType: 1, closest: (_sel: string) => null };
  assert.equal(shouldCaptureNode(el), true);
});

test('shouldCaptureNode drops a tagged element and any descendant of one', () => {
  const tagged = { nodeType: 1 };
  // closest() returns the marked ancestor (or self) → excluded.
  const self = { nodeType: 1, closest: (sel: string) => (sel === `[${CAPTURE_IGNORE_ATTR}]` ? tagged : null) };
  const descendant = { nodeType: 1, closest: (sel: string) => (sel === `[${CAPTURE_IGNORE_ATTR}]` ? tagged : null) };
  assert.equal(shouldCaptureNode(self), false);
  assert.equal(shouldCaptureNode(descendant), false);
});

test('shouldCaptureNode keeps text/comment nodes and non-elements', () => {
  assert.equal(shouldCaptureNode({ nodeType: 3 }), true); // text node, no closest
  assert.equal(shouldCaptureNode(null), true);
  assert.equal(shouldCaptureNode(undefined), true);
  assert.equal(shouldCaptureNode('nope'), true);
});

// ── capturePageScreenshot (encoder injected) ───────────────────────────────

function withDom<T>(run: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  g.window = {}; // no getComputedStyle → capture uses the dark fallback bg
  g.document = { body: { nodeType: 1 }, documentElement: { nodeType: 1 } };
  return run().finally(() => {
    if (!hadWindow) delete g.window;
    if (!hadDocument) delete g.document;
  });
}

test('capturePageScreenshot returns the JPEG data URL and passes the right options', async () => {
  await withDom(async () => {
    let capturedNode: unknown;
    let capturedOptions: Record<string, unknown> | undefined;
    const dataUrl = await capturePageScreenshot({
      toJpeg: async (node, options) => {
        capturedNode = node;
        capturedOptions = options;
        return 'data:image/jpeg;base64,AAAA';
      },
    });
    assert.equal(dataUrl, 'data:image/jpeg;base64,AAAA');
    assert.ok(capturedOptions, 'toJpeg was called');
    const options = capturedOptions as Record<string, unknown>;
    const expectedBody = (globalThis as unknown as { document: { body: unknown } }).document.body;
    assert.equal(capturedNode, expectedBody, 'captures document.body');
    assert.equal(options.quality, CAPTURE_JPEG_QUALITY);
    assert.equal(options.pixelRatio, 1);
    assert.equal(options.cacheBust, true);
    assert.equal(options.filter, shouldCaptureNode, 'the feedback-UI filter is wired in');
    assert.equal(typeof options.backgroundColor, 'string');
  });
});

test('capturePageScreenshot fails open to null on a throwing encoder', async () => {
  await withDom(async () => {
    const dataUrl = await capturePageScreenshot({
      toJpeg: async () => {
        throw new Error('rasterize failed');
      },
    });
    assert.equal(dataUrl, null);
  });
});

test('capturePageScreenshot returns null when the encoder yields a non-JPEG result', async () => {
  await withDom(async () => {
    const dataUrl = await capturePageScreenshot({ toJpeg: async () => 'data:image/png;base64,AAAA' });
    assert.equal(dataUrl, null);
  });
});

test('capturePageScreenshot returns null with no DOM (never throws)', async () => {
  const g = globalThis as Record<string, unknown>;
  const hadDocument = 'document' in g;
  if (hadDocument) delete g.document;
  try {
    let called = false;
    const dataUrl = await capturePageScreenshot({
      toJpeg: async () => {
        called = true;
        return 'data:image/jpeg;base64,AAAA';
      },
    });
    assert.equal(dataUrl, null);
    assert.equal(called, false, 'the encoder is never invoked without a DOM');
  } finally {
    if (hadDocument) g.document = {};
  }
});

test('pageCaptureSupported reflects the presence of a client DOM', () => {
  const g = globalThis as Record<string, unknown>;
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  try {
    g.window = {};
    g.document = {};
    assert.equal(pageCaptureSupported(), true);
    delete g.document;
    assert.equal(pageCaptureSupported(), false);
  } finally {
    if (hadWindow) g.window = {}; else delete g.window;
    if (hadDocument) g.document = {}; else delete g.document;
  }
});

// ── rendered dialog wiring ─────────────────────────────────────────────────

test('the report dialog offers the capture button and marks the modal capture-ignored', async () => {
  const g = globalThis as Record<string, unknown>;
  g.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  g.document = { activeElement: null };
  try {
    const { act, create } = await import('react-test-renderer');
    const ReportModal = (await import('../frontend/feedback/report-dialog')).default;

    let root!: import('react-test-renderer').ReactTestRenderer;
    await act(async () => {
      root = create(React.createElement(ReportModal, { onClose: () => {} }));
    });

    assert.equal(
      root.root.findAllByProps({ 'data-testid': 'report-capture-screen' }).length,
      1,
      'the "Capture page" button is offered',
    );
    assert.ok(
      root.root.findAllByProps({ [CAPTURE_IGNORE_ATTR]: '' }).length >= 1,
      'the modal root is marked so the capture excludes the feedback UI',
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    delete g.window;
    delete g.document;
  }
});

test('the report dialog no longer uses the getDisplayMedia screen-share API (AA-77)', () => {
  const dialogSrc = readFileSync(
    fileURLToPath(new URL('../frontend/feedback/report-dialog.tsx', import.meta.url)),
    'utf8',
  );
  assert.ok(
    !dialogSrc.includes('getDisplayMedia'),
    'report-dialog.tsx must not reference the getDisplayMedia screen-share picker',
  );
});
