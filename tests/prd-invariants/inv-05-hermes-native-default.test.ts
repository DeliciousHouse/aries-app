// PRD §20 invariant 5:
//   "Active social-content workflows are Hermes-native by default."
//
// Operationalized as: backend/execution/provider-factory.ts must default to
// Hermes when no env var is set and when ARIES_EXECUTION_PROVIDER is empty
// or 'hermes'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EXECUTION_PROVIDER,
  resolveExecutionProviderName,
  getExecutionProvider,
} from '../../backend/execution/provider-factory';

test('DEFAULT_EXECUTION_PROVIDER is hermes', () => {
  assert.equal(DEFAULT_EXECUTION_PROVIDER, 'hermes');
});

test('resolveExecutionProviderName returns hermes for an empty env', () => {
  assert.equal(resolveExecutionProviderName({}), 'hermes');
});

test('resolveExecutionProviderName returns hermes when ARIES_EXECUTION_PROVIDER is unset', () => {
  assert.equal(
    resolveExecutionProviderName({ ARIES_EXECUTION_PROVIDER: undefined }),
    'hermes',
  );
});

test('getExecutionProvider returns a usable adapter (no throw on default env)', () => {
  const provider = getExecutionProvider({});
  assert.ok(provider, 'expected a non-null execution provider');
});
