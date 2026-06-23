import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';

import FeedbackWidget from '../frontend/feedback/feedback-widget';

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
