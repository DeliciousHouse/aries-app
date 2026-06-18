/**
 * Unit tests for resolveInstagramAccount (#692/#693).
 *
 * Locked behaviors:
 *  - DEFAULT_INSTAGRAM_GET_ME_SLUG forwarded when no config override
 *  - { ig_user_id: 'me' } forwarded in arguments
 *  - connectedAccountId forwarded to executeTool
 *  - Nested shape (data.data.id) → { igUserId, username }
 *  - Direct shape (data.id)      → { igUserId, username }
 *  - config `account_info` override honored
 *  - successful:false → null  (fail-safe, never invents a user id)
 *  - null / missing-id payload → null
 *  - Blank-string id → null
 *  - username is null when absent from payload
 *
 * Entirely self-contained: fake gateway + config, no Postgres, no Composio SDK.
 * Mirrors the structure of tests/composio-x-user-resolver.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveInstagramAccount,
  DEFAULT_INSTAGRAM_GET_ME_SLUG,
} from '@/backend/integrations/composio/instagram-account-resolver';
import { fakeConfig, fakeGateway } from './composio/helpers';

// ── 1. Default slug + forwarding ─────────────────────────────────────────────

test('uses DEFAULT_INSTAGRAM_GET_USER_INFO slug, forwards {ig_user_id:"me"}, forwards connectedAccountId', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { id: '12345678901', username: 'sugarleather' } },
    },
  });
  await resolveInstagramAccount(gateway, fakeConfig(), 'ca_ig_42');
  assert.equal(gateway.calls.length, 1, 'exactly one executeTool call');
  assert.equal(gateway.calls[0].slug, DEFAULT_INSTAGRAM_GET_ME_SLUG);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_ig_42');
  assert.equal(gateway.calls[0].options.arguments?.ig_user_id, 'me');
  assert.match(String(gateway.calls[0].options.arguments?.fields), /followers_count/);
});

// ── 2. Nested shape (data.data.*) ─────────────────────────────────────────────

test('nested shape (data.data.id): resolves igUserId + username', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { id: '98765432101', username: 'aries_ig', followers_count: 1200 } },
    },
  });
  const result = await resolveInstagramAccount(gateway, fakeConfig(), 'ca_ig_1');
  assert.deepEqual(result, { igUserId: '98765432101', username: 'aries_ig' });
});

// ── 3. Direct shape (data.*) ─────────────────────────────────────────────────

test('direct shape (data.id): resolves igUserId + username when extra envelope is absent', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { id: '11111111111', username: 'direct_ig_user' },
    },
  });
  const result = await resolveInstagramAccount(gateway, fakeConfig(), 'ca_ig_2');
  assert.deepEqual(result, { igUserId: '11111111111', username: 'direct_ig_user' });
});

// ── 4. account_info slug override ────────────────────────────────────────────

test('honors account_info slug override (COMPOSIO_INSTAGRAM_ACCOUNT_INFO_ACTION)', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { id: '22222222222', username: 'override_user' } },
    },
  });
  await resolveInstagramAccount(
    gateway,
    fakeConfig({ actions: { account_info: 'CUSTOM_IG_USER_LOOKUP_V2' } }),
    'ca_ig_1',
  );
  assert.equal(gateway.calls[0].slug, 'CUSTOM_IG_USER_LOOKUP_V2');
  assert.notEqual(gateway.calls[0].slug, DEFAULT_INSTAGRAM_GET_ME_SLUG, 'override replaces the default');
});

// ── 5. Fail-safe: must return null, never invent a user id ───────────────────

test('successful:false → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: false, error: 'unauthorized', data: null },
  });
  const result = await resolveInstagramAccount(gateway, fakeConfig(), 'ca_ig_1');
  assert.equal(result, null);
});

test('successful:true but data is null → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: null },
  });
  const result = await resolveInstagramAccount(gateway, fakeConfig(), 'ca_ig_1');
  assert.equal(result, null);
});

test('successful:true but data has no id field → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { username: 'noId', followers_count: 100 } },
  });
  const result = await resolveInstagramAccount(gateway, fakeConfig(), 'ca_ig_1');
  assert.equal(result, null);
});

test('successful:true but data.data has no id field → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: { username: 'noIdNested' } } },
  });
  const result = await resolveInstagramAccount(gateway, fakeConfig(), 'ca_ig_1');
  assert.equal(result, null);
});

test('successful:true but id is blank string → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: { id: '   ', username: 'blankId' } } },
  });
  const result = await resolveInstagramAccount(gateway, fakeConfig(), 'ca_ig_1');
  assert.equal(result, null);
});

// ── 6. Optional username field ────────────────────────────────────────────────

test('nested shape with id but no username → username is null', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { id: '33333333333' } },
    },
  });
  const result = await resolveInstagramAccount(gateway, fakeConfig(), 'ca_ig_1');
  assert.equal(result?.igUserId, '33333333333');
  assert.equal(result?.username, null);
});

test('direct shape with id but no username → username is null', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { id: '44444444444' },
    },
  });
  const result = await resolveInstagramAccount(gateway, fakeConfig(), 'ca_ig_1');
  assert.equal(result?.igUserId, '44444444444');
  assert.equal(result?.username, null);
});

// ── 7. Fail-safe on gateway throw ─────────────────────────────────────────────

test('gateway throw → null (fail-safe, never propagates to the worker tick)', async () => {
  const throwingGateway = {
    ...fakeGateway(),
    async executeTool() {
      throw new Error('Composio 503');
    },
  };
  const result = await resolveInstagramAccount(throwingGateway, fakeConfig(), 'ca_ig_1');
  assert.equal(result, null);
});
