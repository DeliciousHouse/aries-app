import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_EXECUTION_PROVIDER,
  ExecutionError,
  getExecutionProvider,
  resolveExecutionProviderName,
} from '../backend/execution';

test('resolveExecutionProviderName defaults to legacy-openclaw when ARIES_EXECUTION_PROVIDER is unset', () => {
  assert.equal(DEFAULT_EXECUTION_PROVIDER, 'legacy-openclaw');
  assert.equal(resolveExecutionProviderName({}), 'legacy-openclaw');
  assert.equal(resolveExecutionProviderName({ ARIES_EXECUTION_PROVIDER: '' }), 'legacy-openclaw');
});

test('resolveExecutionProviderName accepts explicit legacy-openclaw selection', () => {
  assert.equal(
    resolveExecutionProviderName({ ARIES_EXECUTION_PROVIDER: 'legacy-openclaw' }),
    'legacy-openclaw',
  );
});

test('getExecutionProvider returns the legacy provider when legacy-openclaw is selected', () => {
  const provider = getExecutionProvider({ ARIES_EXECUTION_PROVIDER: 'legacy-openclaw' });

  assert.equal(provider.name, 'legacy-openclaw');
  assert.equal(typeof provider.runWorkflow, 'function');
});

test('getExecutionProvider returns a Hermes stub that explains missing Hermes configuration', async () => {
  const provider = getExecutionProvider({
    ARIES_EXECUTION_PROVIDER: 'hermes',
  });

  assert.equal(provider.name, 'hermes');

  const result = await provider.runWorkflow('marketing_demo', { tenantId: 'tenant_123' });

  assert.equal(result.kind, 'gateway_error');
  if (result.kind !== 'gateway_error') {
    throw new Error('expected Hermes stub to return a gateway_error result');
  }

  assert.ok(result.error instanceof ExecutionError);
  assert.equal(result.error.provider, 'hermes');
  assert.equal(result.error.code, 'not_configured');
  assert.match(result.error.message, /ARIES_EXECUTION_PROVIDER=hermes/);
  assert.match(result.error.message, /HERMES_GATEWAY_URL/);
  assert.match(result.error.message, /HERMES_GATEWAY_TOKEN/);
});
