/**
 * Unit tests for resolveXUser (#670).
 *
 * Locked behaviors:
 *  - Nested shape (data.data.username) → { username, name }
 *  - Direct shape (data.username)      → { username, name }
 *  - DEFAULT_X_GET_ME_SLUG forwarded when no config override
 *  - connectedAccountId forwarded to executeTool
 *  - config `account_info` override (COMPOSIO_X_ACCOUNT_INFO_ACTION) honored
 *  - successful:false → null  (never invents a username)
 *  - null / missing-username payload → null
 *  - Blank-string username → null
 *  - name is null when absent from payload
 *
 * Entirely self-contained: fake gateway + config, no Postgres, no Composio SDK.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveXUser,
  DEFAULT_X_GET_ME_SLUG,
} from '@/backend/integrations/composio/x-user-resolver';
import { fakeConfig, fakeGateway } from './composio/helpers';

// ── 1. Nested shape (data.data.*) ────────────────────────────────────────────

test('nested shape: resolves username + name from data.data.*', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { id: '123', username: 'sugarleather', name: 'Sugar & Leather' } },
    },
  });
  const result = await resolveXUser(gateway, fakeConfig(), 'ca_x_1');
  assert.deepEqual(result, { username: 'sugarleather', name: 'Sugar & Leather' });
});

// ── 2. Direct shape (data.*) ─────────────────────────────────────────────────

test('direct shape: resolves username from data.username', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { username: 'aries_direct', name: 'Aries Direct' },
    },
  });
  const result = await resolveXUser(gateway, fakeConfig(), 'ca_x_2');
  assert.deepEqual(result, { username: 'aries_direct', name: 'Aries Direct' });
});

// ── 3. Default slug + connectedAccountId forwarding ──────────────────────────

test('uses DEFAULT_X_GET_ME_SLUG and forwards connectedAccountId', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { username: 'some_user' } },
    },
  });
  await resolveXUser(gateway, fakeConfig(), 'ca_x_99');
  assert.equal(gateway.calls.length, 1, 'exactly one executeTool call');
  assert.equal(gateway.calls[0].slug, DEFAULT_X_GET_ME_SLUG);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_x_99');
});

// ── 4. account_info slug override ────────────────────────────────────────────

test('honors account_info slug override (COMPOSIO_X_ACCOUNT_INFO_ACTION)', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { username: 'override_user' } },
    },
  });
  await resolveXUser(
    gateway,
    fakeConfig({ actions: { account_info: 'CUSTOM_X_LOOKUP_V2' } }),
    'ca_x_1',
  );
  assert.equal(gateway.calls[0].slug, 'CUSTOM_X_LOOKUP_V2');
  assert.notEqual(gateway.calls[0].slug, DEFAULT_X_GET_ME_SLUG, 'override replaces the default');
});

// ── 5. Fail-safe: must return null, never invent a username ───────────────────

test('unsuccessful top-level result → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: false, error: 'unauthorized', data: null },
  });
  const result = await resolveXUser(gateway, fakeConfig(), 'ca_x_1');
  assert.equal(result, null);
});

test('successful result but data is null → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: null },
  });
  const result = await resolveXUser(gateway, fakeConfig(), 'ca_x_1');
  assert.equal(result, null);
});

test('successful result but data has no username field → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: '123', name: 'No Handle' } },
  });
  const result = await resolveXUser(gateway, fakeConfig(), 'ca_x_1');
  assert.equal(result, null);
});

test('successful result but data.data has no username field → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: { id: '123', name: 'No Handle' } } },
  });
  const result = await resolveXUser(gateway, fakeConfig(), 'ca_x_1');
  assert.equal(result, null);
});

test('successful result but username is blank string → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: { username: '   ' } } },
  });
  const result = await resolveXUser(gateway, fakeConfig(), 'ca_x_1');
  assert.equal(result, null);
});

// ── 6. Optional name field ────────────────────────────────────────────────────

test('nested shape with username but no name field → name is null', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { username: 'noname_user' } },
    },
  });
  const result = await resolveXUser(gateway, fakeConfig(), 'ca_x_1');
  assert.equal(result?.username, 'noname_user');
  assert.equal(result?.name, null);
});

test('direct shape with username but no name field → name is null', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { username: 'direct_noname' },
    },
  });
  const result = await resolveXUser(gateway, fakeConfig(), 'ca_x_1');
  assert.equal(result?.username, 'direct_noname');
  assert.equal(result?.name, null);
});
