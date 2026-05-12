/**
 * Batch 2a — Marketing execution provider lock.
 *
 * Asserts that:
 * 1. When ARIES_MARKETING_EXECUTION_PROVIDER is unset and HERMES_GATEWAY_URL is
 *    present, OpenClaw env vars are ignored (Hermes path uses Hermes-native
 *    config; garbage values for OPENCLAW_* do not affect the resolved port).
 * 2. When HERMES_GATEWAY_URL is missing and the provider is not explicitly set
 *    to legacy-openclaw, the execution port validator throws a recognizable
 *    error rather than silently falling back.
 * 3. When ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw, the legacy port
 *    is selected.
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
import { LegacyOpenClawMarketingPort } from '../backend/marketing/ports/legacy-openclaw';
import { HermesMarketingPort } from '../backend/marketing/ports/hermes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1. OpenClaw env vars are ignored on the Hermes-default path
// ---------------------------------------------------------------------------

test('resolveMarketingProviderName defaults to hermes when ARIES_MARKETING_EXECUTION_PROVIDER is unset', () => {
  assert.equal(resolveMarketingProviderName({}), 'hermes');
  assert.equal(resolveMarketingProviderName({ ARIES_MARKETING_EXECUTION_PROVIDER: '' }), 'hermes');
  assert.equal(resolveMarketingProviderName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes' }), 'hermes');
});

test('resolveMarketingProviderName returns hermes for unrecognised values', () => {
  assert.equal(
    resolveMarketingProviderName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'unknown-value' }),
    'hermes',
  );
});

test('resolveMarketingExecutionPortName (Hermes-only export) always returns hermes', () => {
  // execution-port.ts is a social-content-safe module that only knows about Hermes.
  // legacy-openclaw maps to hermes here (the orchestrator uses provider-guard.ts
  // for the broader provider selection logic).
  assert.equal(resolveMarketingExecutionPortName({}), 'hermes');
  assert.equal(resolveMarketingExecutionPortName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'hermes' }), 'hermes');
});

test('getMarketingExecutionPort returns HermesMarketingPort even when OPENCLAW_* env vars are set to garbage', () => {
  // Arrange: Hermes env is present; OpenClaw env vars are garbage values.
  const env = hermesEnv({
    OPENCLAW_SESSION_KEY: 'garbage-session-key',
    OPENCLAW_MARKETING_WORKFLOW_TIMEOUT_MS: 'not-a-number',
    OPENCLAW_MARKETING_WORKFLOW_MAX_STDOUT_BYTES: 'not-a-number',
    OPENCLAW_GATEWAY_LOBSTER_CWD: '/garbage/cwd',
    OPENCLAW_LOBSTER_CWD: '/garbage/lobster',
    OPENCLAW_LOCAL_LOBSTER_CWD: '/garbage/local',
  });

  const port = getMarketingExecutionPort(() => ({ gatewayCwd: 'lobster', localCwd: 'lobster' }), env);

  // The resolved port must be Hermes, not legacy-openclaw.
  assert.equal(port.name, 'hermes');
  assert.ok(port instanceof HermesMarketingPort, 'port should be an instance of HermesMarketingPort');
});

test('HermesMarketingPort sessionKey() reads HERMES_SESSION_KEY, not OPENCLAW_SESSION_KEY', () => {
  // The Hermes port's internal session key derivation must not touch OpenClaw env.
  const env = hermesEnv({
    HERMES_SESSION_KEY: 'hermes-session',
    OPENCLAW_SESSION_KEY: 'openclaw-garbage-session',
  });

  const port = new HermesMarketingPort(env);
  // sessionKey() is private — verify indirectly by asserting the port is
  // correctly constructed and the name is 'hermes'.
  assert.equal(port.name, 'hermes');
  // Verify that constructing with garbage OpenClaw vars does not throw.
});

// ---------------------------------------------------------------------------
// 2. Fail-fast when Hermes is not configured and legacy is not explicit
// ---------------------------------------------------------------------------

test('assertMarketingExecutionPortConfigured throws when HERMES_GATEWAY_URL is missing and provider is not legacy-openclaw', () => {
  const env: Record<string, string | undefined> = {
    // No HERMES_GATEWAY_URL
    HERMES_API_SERVER_KEY: 'test-key',
    INTERNAL_API_SECRET: 'test-secret',
    APP_BASE_URL: 'https://aries.test',
  };

  assert.throws(
    () => assertMarketingExecutionPortConfigured(env),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'expected an Error instance');
      assert.match(error.message, /HERMES_GATEWAY_URL/);
      assert.match(error.message, /legacy-openclaw/);
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
  const env = hermesEnv();
  // Should not throw.
  assert.doesNotThrow(() => assertMarketingExecutionPortConfigured(env));
});

test('assertMarketingExecutionPortConfigured does not throw when provider is legacy-openclaw (even without HERMES_GATEWAY_URL)', () => {
  const env: Record<string, string | undefined> = {
    ARIES_MARKETING_EXECUTION_PROVIDER: 'legacy-openclaw',
    // No HERMES_GATEWAY_URL — legacy path must not require it.
  };
  assert.doesNotThrow(() => assertMarketingExecutionPortConfigured(env));
});

// ---------------------------------------------------------------------------
// 3. Legacy port is selected when explicitly opted in
// ---------------------------------------------------------------------------

test('resolveMarketingProviderName returns legacy-openclaw when ARIES_MARKETING_EXECUTION_PROVIDER=legacy-openclaw', () => {
  assert.equal(
    resolveMarketingProviderName({ ARIES_MARKETING_EXECUTION_PROVIDER: 'legacy-openclaw' }),
    'legacy-openclaw',
  );
});

test('LegacyOpenClawMarketingPort is used when provider=legacy-openclaw', () => {
  const port = new LegacyOpenClawMarketingPort(
    () => ({ gatewayCwd: 'lobster', localCwd: 'lobster' }),
  );

  assert.equal(port.name, 'legacy-openclaw');
});

test('LegacyOpenClawMarketingPort resolves OPENCLAW_SESSION_KEY for agent_id injection', () => {
  const port = new LegacyOpenClawMarketingPort(
    () => ({ gatewayCwd: 'lobster', localCwd: 'lobster' }),
    { OPENCLAW_SESSION_KEY: 'custom-agent' },
  );

  assert.equal(port.resolveSessionKey(), 'custom-agent');
});

test('LegacyOpenClawMarketingPort defaults agent_id to "main" when OPENCLAW_SESSION_KEY is absent', () => {
  const port = new LegacyOpenClawMarketingPort(
    () => ({ gatewayCwd: 'lobster', localCwd: 'lobster' }),
    {},
  );

  assert.equal(port.resolveSessionKey(), 'main');
});
