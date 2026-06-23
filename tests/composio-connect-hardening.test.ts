/**
 * Regression coverage for #655 (X connect 500s with raw Composio error) and
 * #640 (Reddit connect falls back to wrong default).
 *
 * Root cause: when no per-platform auth-config id is configured, the account
 * provider falls back to findOrCreateManagedAuthConfig. For custom-OAuth
 * toolkits (twitter/X, reddit) that have NO Composio-managed shared
 * credentials, the SDK throws a raw error. That raw error escaped as HTTP 500
 * with reason:'composio_error' and the raw SDK message visible to operators.
 *
 * Fix: wrap findOrCreateManagedAuthConfig in a try/catch; on failure raise
 * ComposioConfigError (503, composio_not_configured) with a frontend-safe
 * message that names COMPOSIO_<PLATFORM>_AUTH_CONFIG_ID so the operator knows
 * exactly what env var to set. Managed toolkits (facebook/instagram/etc.) are
 * byte-identical — their findOrCreateManagedAuthConfig succeeds so the catch
 * never fires.
 *
 * Failure modes locked:
 *  a. X (twitter) connect with rejecting gateway → ComposioConfigError,
 *     message names COMPOSIO_X_AUTH_CONFIG_ID, does not include raw SDK text.
 *  b. Reddit connect with rejecting gateway → ComposioConfigError,
 *     message names COMPOSIO_REDDIT_AUTH_CONFIG_ID, does not include raw SDK text.
 *  c. Regression: facebook with resolving gateway → connect succeeds,
 *     initiateConnection is called, no throw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComposioAccountProvider } from '@/backend/integrations/composio/composio-account-provider';
import { ComposioConfigError } from '@/backend/integrations/composio/errors';
import type {
  ComposioGateway,
  GatewayConnection,
  GatewayInitiateResult,
  GatewayToolResult,
} from '@/backend/integrations/composio/composio-client';
import { fakeConfig, fakeDb } from './composio/helpers';

// ── Fake gateway helpers ──────────────────────────────────────────────────────

/**
 * A gateway whose findOrCreateManagedAuthConfig REJECTS with the given error.
 * All other gateway methods are no-ops so the failure path can be tested
 * without any DB or network interaction.
 */
function rejectingGateway(err: Error): ComposioGateway {
  return {
    async findOrCreateManagedAuthConfig(): Promise<string> {
      throw err;
    },
    async initiateConnection(): Promise<GatewayInitiateResult> {
      return { connectionRequestId: 'cr_1', redirectUrl: 'https://composio.dev/connect/abc' };
    },
    async listConnections(): Promise<GatewayConnection[]> {
      return [];
    },
    async getConnection(): Promise<GatewayConnection | null> {
      return null;
    },
    async deleteConnection(): Promise<void> {
      /* no-op */
    },
    async executeTool(): Promise<GatewayToolResult> {
      return { data: {}, successful: true, error: null };
    },
    async uploadFile() {
      return { name: 'staged.jpg', mimetype: 'image/jpeg', s3key: 's3/test/staged.jpg' };
    },
  };
}

/**
 * A gateway whose findOrCreateManagedAuthConfig RESOLVES. Tracks whether
 * initiateConnection was invoked (the managed-path regression guard).
 */
function resolvingGateway() {
  const state = { initiateConnectionCalled: false };
  const gw: ComposioGateway = {
    async findOrCreateManagedAuthConfig(): Promise<string> {
      return 'ac_managed_facebook';
    },
    async initiateConnection(): Promise<GatewayInitiateResult> {
      state.initiateConnectionCalled = true;
      return { connectionRequestId: 'cr_1', redirectUrl: 'https://composio.dev/connect/abc' };
    },
    async listConnections(): Promise<GatewayConnection[]> {
      return [];
    },
    async getConnection(): Promise<GatewayConnection | null> {
      return null;
    },
    async deleteConnection(): Promise<void> {
      /* no-op */
    },
    async executeTool(): Promise<GatewayToolResult> {
      return { data: {}, successful: true, error: null };
    },
    async uploadFile() {
      return { name: 'staged.jpg', mimetype: 'image/jpeg', s3key: 's3/test/staged.jpg' };
    },
  };
  return { gw, state };
}

// Raw SDK error text that must never appear in the frontend-visible message.
const RAW_SDK_ERROR = 'Internal Composio SDK error: no managed credentials for this toolkit';

const tenantId = '99';
const userId = 'aries-tenant-99';

// ── a. X (#655): raw SDK error → ComposioConfigError naming COMPOSIO_X_AUTH_CONFIG_ID ──

test('#655 X connect: findOrCreateManagedAuthConfig failure raises ComposioConfigError, not raw SDK error', async () => {
  const provider = new ComposioAccountProvider(
    rejectingGateway(new Error(RAW_SDK_ERROR)),
    fakeConfig({ authConfigId: null }),
    fakeDb(),
  );

  await assert.rejects(
    () => provider.createConnectLink(userId, 'x', 'full', { tenantId }),
    (err: unknown) => {
      assert.ok(err instanceof ComposioConfigError, `expected ComposioConfigError, got ${String(err)}`);
      assert.ok(
        err.message.includes('COMPOSIO_X_AUTH_CONFIG_ID'),
        `message must name COMPOSIO_X_AUTH_CONFIG_ID; got: ${err.message}`,
      );
      assert.ok(
        !err.message.includes(RAW_SDK_ERROR),
        `message must NOT include raw SDK error text; got: ${err.message}`,
      );
      assert.equal(err.code, 'composio_not_configured');
      assert.equal(err.status, 503);
      return true;
    },
  );
});

// ── b. Reddit (#640): raw SDK error → ComposioConfigError naming COMPOSIO_REDDIT_AUTH_CONFIG_ID ──

test('#640 Reddit connect: findOrCreateManagedAuthConfig failure raises ComposioConfigError, not raw SDK error', async () => {
  const provider = new ComposioAccountProvider(
    rejectingGateway(new Error(RAW_SDK_ERROR)),
    fakeConfig({ authConfigId: null }),
    fakeDb(),
  );

  await assert.rejects(
    () => provider.createConnectLink(userId, 'reddit', 'full', { tenantId }),
    (err: unknown) => {
      assert.ok(err instanceof ComposioConfigError, `expected ComposioConfigError, got ${String(err)}`);
      assert.ok(
        err.message.includes('COMPOSIO_REDDIT_AUTH_CONFIG_ID'),
        `message must name COMPOSIO_REDDIT_AUTH_CONFIG_ID; got: ${err.message}`,
      );
      assert.ok(
        !err.message.includes(RAW_SDK_ERROR),
        `message must NOT include raw SDK error text; got: ${err.message}`,
      );
      assert.ok(
        !err.message.toLowerCase().includes('custom oauth app'),
        `message must NOT include 'custom oauth app' for reddit (reddit has Composio-managed auth, #668); got: ${err.message}`,
      );
      assert.equal(err.code, 'composio_not_configured');
      assert.equal(err.status, 503);
      return true;
    },
  );
});

// ── b2. Reddit managed connect: resolving gateway → succeeds (#668) ───────────

test('#668 reddit managed connect: findOrCreateManagedAuthConfig resolves → connect succeeds, initiateConnection called', async () => {
  // Proves that when Composio-managed auth provisioning succeeds for reddit
  // (the happy path), createConnectLink completes normally — no ComposioConfigError,
  // no "custom OAuth app" message. Reddit HAS managed credentials.
  const { gw, state } = resolvingGateway();
  const provider = new ComposioAccountProvider(
    gw,
    fakeConfig({ authConfigId: null }), // no explicit id → falls through to findOrCreate
    fakeDb(),
  );

  const result = await provider.createConnectLink(userId, 'reddit', 'full', { tenantId });

  assert.equal(result.connectUrl, 'https://composio.dev/connect/abc');
  assert.ok(
    state.initiateConnectionCalled,
    'initiateConnection must be called when findOrCreateManagedAuthConfig resolves for reddit',
  );
  assert.equal(result.platform, 'reddit');
  assert.equal(result.provider, 'composio');
});

// ── c. Regression guard: managed toolkit (facebook) is byte-identical ─────────

test('managed toolkit (facebook): findOrCreateManagedAuthConfig resolves → connect succeeds, initiateConnection called', async () => {
  const { gw, state } = resolvingGateway();
  const provider = new ComposioAccountProvider(
    gw,
    fakeConfig({ authConfigId: null }), // no configured id → falls through to findOrCreate
    fakeDb(),
  );

  // Must not throw; must proceed to initiateConnection and return a connectUrl.
  const result = await provider.createConnectLink(userId, 'facebook', 'full', { tenantId });

  assert.equal(result.connectUrl, 'https://composio.dev/connect/abc');
  assert.ok(
    state.initiateConnectionCalled,
    'initiateConnection must be called when findOrCreateManagedAuthConfig resolves',
  );
  assert.equal(result.platform, 'facebook');
  assert.equal(result.provider, 'composio');
});
