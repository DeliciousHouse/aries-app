/**
 * Marketing execution provider lock.
 *
 * Asserts that:
 * 1. Marketing execution always resolves to the Hermes port; stale OPENCLAW_*
 *    env vars do not affect the resolved port.
 * 2. When HERMES_GATEWAY_URL is missing, the execution port validator throws a
 *    recognizable error rather than silently falling back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getMarketingExecutionPort,
  resolveMarketingExecutionPortName,
} from '../backend/marketing/execution-port';
import {
  assertMarketingExecutionPortConfigured,
  resolveMarketingProviderName,
} from '../backend/marketing/provider-guard';
import { HermesMarketingPort } from '../backend/marketing/ports/hermes';

/** Build a minimal env object that satisfies the Hermes configuration check. */
function hermesEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    HERMES_GATEWAY_URL: 'https://hermes.test:8642',
    HERMES_API_SERVER_KEY: 'test-key',
    INTERNAL_API_SECRET: 'test-internal-secret',
    APP_BASE_URL: 'https://aries.test',
    ...overrides,
  };
}

test('resolveMarketingProviderName always resolves to hermes', () => {
  assert.equal(resolveMarketingProviderName({}), 'hermes');
  assert.equal(resolveMarketingProviderName({ ARIES_MARKETING_EXECUTION_PROVIDER: '' }), 'hermes');
  assert.equal(resolveMarketingProviderName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes' }), 'hermes');
  assert.equal(resolveMarketingProviderName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'unknown-value' }), 'hermes');
});

test('resolveMarketingExecutionPortName always returns hermes', () => {
  assert.equal(resolveMarketingExecutionPortName({}), 'hermes');
  assert.equal(resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes' }), 'hermes');
});

test('getMarketingExecutionPort returns HermesMarketingPort even when stale OPENCLAW_* env vars are set', () => {
  const env = hermesEnv({
    OPENCLAW_SESSION_KEY: 'garbage-session-key',
    ARTIFACT_PIPELINE_GATEWAY_CWD: '/garbage/cwd',
  });

  const port = getMarketingExecutionPort(env);

  assert.equal(port.name, 'hermes');
  assert.ok(port instanceof HermesMarketingPort, 'port should be an instance of HermesMarketingPort');
});

test('HermesMarketingPort constructs cleanly when stale OPENCLAW_SESSION_KEY is set', () => {
  const env = hermesEnv({
    HERMES_SESSION_KEY: 'hermes-session',
    OPENCLAW_SESSION_KEY: 'openclaw-garbage-session',
  });

  const port = new HermesMarketingPort(env);
  assert.equal(port.name, 'hermes');
});

test('assertMarketingExecutionPortConfigured throws when HERMES_GATEWAY_URL is missing', () => {
  const env: Record<string, string | undefined> = {
    HERMES_API_SERVER_KEY: 'test-key',
    INTERNAL_API_SECRET: 'test-secret',
    APP_BASE_URL: 'https://aries.test',
  };

  assert.throws(
    () => assertMarketingExecutionPortConfigured(env),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'expected an Error instance');
      assert.match(error.message, /HERMES_GATEWAY_URL/);
      return true;
    },
  );
});

test('assertMarketingExecutionPortConfigured throws when env is completely empty', () => {
  assert.throws(
    () => assertMarketingExecutionPortConfigured({}),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'expected an Error instance');
      assert.match(error.message, /HERMES_GATEWAY_URL/);
      return true;
    },
  );
});

test('assertMarketingExecutionPortConfigured does not throw when HERMES_GATEWAY_URL is set', () => {
  assert.doesNotThrow(() => assertMarketingExecutionPortConfigured(hermesEnv()));
});
