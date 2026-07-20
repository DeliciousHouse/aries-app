import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import React from 'react';

import FeedbackWidget from '../frontend/feedback/feedback-widget';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// The modal renders through createPortal(document.body), which escapes the
// react-test-renderer tree (and needs a DOM), so this smoke test asserts the
// always-present floating button — the "feedback button on every page" contract.
test('feedback widget renders a labelled feedback button on every page', async () => {
  const { act, create } = await import('react-test-renderer');
  let root!: import('react-test-renderer').ReactTestRenderer;

  await act(async () => {
    root = create(React.createElement(FeedbackWidget));
    await flushMicrotasks();
  });

  const button = root.root.findByProps({ 'data-testid': 'feedback-button' });
  assert.equal(button.props['aria-label'], 'Send feedback');
  assert.equal(button.props['aria-haspopup'], 'dialog');

  // No modal is open until the button is clicked.
  const dialogs = root.root.findAllByProps({ role: 'dialog' });
  assert.equal(dialogs.length, 0);

  await act(async () => {
    root.unmount();
  });
});

test('public-page feedback opens the durable report pipeline without an auth probe', async () => {
  let fetchCalls = 0;
  (globalThis as Record<string, unknown>).fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({}) };
  };

  try {
    const { act, create } = await import('react-test-renderer');
    let root!: import('react-test-renderer').ReactTestRenderer;
    await act(async () => {
      root = create(React.createElement(FeedbackWidget));
      await flushMicrotasks();
    });

    const button = root.root.findByProps({ 'data-testid': 'feedback-button' });
    await act(async () => {
      button.props.onClick();
      await flushMicrotasks();
    });
    assert.equal(fetchCalls, 0, 'opening feedback must not race an auth/session probe');

    await act(async () => root.unmount());
  } finally {
    delete (globalThis as Record<string, unknown>).fetch;
  }

  const source = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'feedback', 'feedback-widget.tsx'),
    'utf8',
  );
  assert.doesNotMatch(source, /api\/auth\/session/);
  assert.match(source, /<ReportModal onClose=/);
  assert.doesNotMatch(source, /<FeedbackModal onClose=/);
});
