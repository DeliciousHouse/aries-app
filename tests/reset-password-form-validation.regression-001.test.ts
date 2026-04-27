import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

import ResetPasswordForm from '../frontend/auth/reset-password-form';

type ResetPasswordFormProps = React.ComponentProps<typeof ResetPasswordForm>;

type RenderedResetPasswordForm = {
  act: typeof import('react-test-renderer').act;
  root: ReactTestRenderer;
  submitCalls: Array<[email: string, code: string, password: string]>;
};

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderResetPasswordForm(
  overrides: Partial<ResetPasswordFormProps> = {},
): Promise<RenderedResetPasswordForm> {
  const { act, create } = await import('react-test-renderer');
  const submitCalls: Array<[email: string, code: string, password: string]> = [];
  const defaultProps: ResetPasswordFormProps = {
    email: 'user@example.com',
    onNavigate() {},
    onSubmit(email, code, password) {
      submitCalls.push([email, code, password]);
    },
    isLoading: false,
  };

  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(React.createElement(ResetPasswordForm, { ...defaultProps, ...overrides }));
    await flushMicrotasks();
  });

  return { act, root, submitCalls };
}

function textContent(node: ReactTestInstance | string | number | null | undefined): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map((child) => textContent(child as ReactTestInstance | string)).join('');
}

function findSubmitButton(root: ReactTestRenderer): ReactTestInstance {
  return root.root.findAllByType('button').find((button) => button.props.type === 'submit')!;
}

function findInputByVisibleLabel(root: ReactTestRenderer, labelText: string): ReactTestInstance {
  const label = root.root.findAllByType('label').find((candidate) => textContent(candidate) === labelText);
  assert.ok(label, `${labelText} label should render`);
  assert.equal(typeof label.props.htmlFor, 'string', `${labelText} label should target an input`);

  const input = root.root.findAllByType('input').find((candidate) => candidate.props.id === label.props.htmlFor);
  assert.ok(input, `${labelText} input should be associated with its visible label`);
  return input;
}

function alertMessages(root: ReactTestRenderer): string[] {
  return root.root.findAllByProps({ role: 'alert' }).map((alert) => textContent(alert));
}

test('reset password keeps invalid forms disabled and ignores invalid submits', async () => {
  const { act, root, submitCalls } = await renderResetPasswordForm();
  const submitButton = findSubmitButton(root);

  assert.equal(submitButton.props.disabled, true, 'Update Password should start disabled until all fields are valid');

  const form = root.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
    await flushMicrotasks();
  });

  assert.deepEqual(submitCalls, [], 'invalid programmatic submit should not call onSubmit');
  assert.equal(findSubmitButton(root).props.disabled, true, 'invalid submit should leave the button disabled');
  assert.deepEqual(alertMessages(root), [
    'Enter the 6-digit code from your email.',
    'Enter your new password.',
    'Enter your confirmation password.',
  ]);
});

test('reset password renders rejected submit failures as accessible alerts', async () => {
  const backendMessage = 'Your recovery code is invalid or expired.';
  const submitCalls: Array<[email: string, code: string, password: string]> = [];
  const { act, root } = await renderResetPasswordForm({
    async onSubmit(email, code, password) {
      submitCalls.push([email, code, password]);
      throw new Error(backendMessage);
    },
  });

  await act(async () => {
    findInputByVisibleLabel(root, 'Recovery Code').props.onChange({ target: { value: ' 123456 ' } });
    findInputByVisibleLabel(root, 'New Password').props.onChange({ target: { value: 'ValidPass1!' } });
    findInputByVisibleLabel(root, 'Confirm Password').props.onChange({ target: { value: 'ValidPass1!' } });
    await flushMicrotasks();
  });

  assert.equal(findSubmitButton(root).props.disabled, false, 'valid reset details should enable submit');

  const form = root.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
    await flushMicrotasks();
  });

  assert.deepEqual(submitCalls, [['user@example.com', '123456', 'ValidPass1!']]);
  assert.ok(
    alertMessages(root).includes(backendMessage),
    'failed reset submissions should render the backend message in a role=alert region',
  );
});

test('reset password exposes visible label associations for each input', async () => {
  const { root } = await renderResetPasswordForm();

  const expectedLabels = ['Recovery Code', 'New Password', 'Confirm Password'];
  for (const labelText of expectedLabels) {
    const input = findInputByVisibleLabel(root, labelText);
    assert.equal(input.props.required, true, `${labelText} should remain a required field`);
  }

  assert.equal(findInputByVisibleLabel(root, 'Recovery Code').props.autoComplete, 'one-time-code');
  assert.equal(findInputByVisibleLabel(root, 'New Password').props.autoComplete, 'new-password');
  assert.equal(findInputByVisibleLabel(root, 'Confirm Password').props.autoComplete, 'new-password');
});
