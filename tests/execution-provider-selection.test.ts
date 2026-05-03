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

  // The runtime provider identifier is 'openclaw' to match the
  // LegacyOpenClawExecutionAdapter and the provider value used on
  // ExecutionError instances. 'legacy-openclaw' is the config-level selector.
  assert.equal(provider.name, 'openclaw');
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
  assert.match(result.error.message, /HERMES_API_SERVER_KEY/);
});

test('runAriesWorkflow honors ARIES_EXECUTION_PROVIDER=hermes through the exported route helper', async () => {
  // Public-path integration: route helpers must actually consult the factory.
  // Without this, ARIES_EXECUTION_PROVIDER has no runtime effect for any
  // route handler that calls runAriesWorkflow.
  const previous = {
    ARIES_EXECUTION_PROVIDER: process.env.ARIES_EXECUTION_PROVIDER,
    HERMES_GATEWAY_URL: process.env.HERMES_GATEWAY_URL,
    HERMES_API_SERVER_KEY: process.env.HERMES_API_SERVER_KEY,
    HERMES_SESSION_KEY: process.env.HERMES_SESSION_KEY,
  };
  process.env.ARIES_EXECUTION_PROVIDER = 'hermes';
  delete process.env.HERMES_GATEWAY_URL;
  delete process.env.HERMES_API_SERVER_KEY;
  delete process.env.HERMES_SESSION_KEY;
  try {
    const { runAriesWorkflow } = await import('../backend/execution');
    const result = await runAriesWorkflow(
      'marketing_demo' as Parameters<typeof runAriesWorkflow>[0],
      { tenantId: 'tenant_123' },
    );

    assert.equal(result.kind, 'gateway_error');
    if (result.kind !== 'gateway_error') {
      throw new Error('expected Hermes stub to return a gateway_error result via route helper');
    }
    assert.ok(result.error instanceof ExecutionError);
    assert.equal(result.error.provider, 'hermes');
    assert.equal(result.error.code, 'not_configured');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
