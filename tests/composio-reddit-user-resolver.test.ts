/**
 * Unit tests for resolveRedditUser (#670).
 *
 * Locked behaviors:
 *  - Two-level shape (data.data.name) → { username, name }
 *  - One-level shape (data.name)      → { username, name }
 *  - DEFAULT_REDDIT_GET_ME_SLUG forwarded when no config override
 *  - connectedAccountId forwarded to executeTool
 *  - arguments:{username:'me'} always passed (Reddit API requirement)
 *  - config `account_info` override (COMPOSIO_REDDIT_ACCOUNT_INFO_ACTION) honored
 *  - successful:false → null  (never invents a username)
 *  - null / missing-name payload → null
 *  - Blank-string name → null
 *
 * Entirely self-contained: fake gateway + config, no Postgres, no Composio SDK.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRedditUser,
  DEFAULT_REDDIT_GET_ME_SLUG,
} from '@/backend/integrations/composio/reddit-user-resolver';
import { fakeConfig, fakeGateway } from './composio/helpers';

// ── 1. Two-level shape (data.data.name) ─────────────────────────────────────

test('two-level shape: resolves username from data.data.name', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { name: 'sugarleather', id: 't2_abc' } },
    },
  });
  const result = await resolveRedditUser(gateway, fakeConfig(), 'ca_reddit_1');
  assert.deepEqual(result, { username: 'sugarleather', name: 'sugarleather' });
});

// ── 2. One-level shape (data.name) ───────────────────────────────────────────

test('one-level shape: resolves username from data.name', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { name: 'aries_redditor' },
    },
  });
  const result = await resolveRedditUser(gateway, fakeConfig(), 'ca_reddit_2');
  assert.deepEqual(result, { username: 'aries_redditor', name: 'aries_redditor' });
});

// ── 3. Default slug + connectedAccountId forwarding ──────────────────────────

test('uses DEFAULT_REDDIT_GET_ME_SLUG and forwards connectedAccountId', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { name: 'some_redditor' } },
    },
  });
  await resolveRedditUser(gateway, fakeConfig(), 'ca_reddit_42');
  assert.equal(gateway.calls.length, 1, 'exactly one executeTool call');
  assert.equal(gateway.calls[0].slug, DEFAULT_REDDIT_GET_ME_SLUG);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_reddit_42');
});

// ── 4. arguments:{username:'me'} required ────────────────────────────────────

test('always passes arguments:{username:"me"} to satisfy Reddit API requirement', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { name: 'me_user' } },
    },
  });
  await resolveRedditUser(gateway, fakeConfig(), 'ca_reddit_1');
  assert.deepEqual(
    gateway.calls[0].options.arguments,
    { username: 'me' },
    'arguments must contain {username:"me"}',
  );
});

// ── 5. account_info slug override ────────────────────────────────────────────

test('honors account_info slug override (COMPOSIO_REDDIT_ACCOUNT_INFO_ACTION)', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: { name: 'override_redditor' } },
    },
  });
  await resolveRedditUser(
    gateway,
    fakeConfig({ actions: { account_info: 'CUSTOM_REDDIT_USER_ABOUT_V2' } }),
    'ca_reddit_1',
  );
  assert.equal(gateway.calls[0].slug, 'CUSTOM_REDDIT_USER_ABOUT_V2');
  assert.notEqual(gateway.calls[0].slug, DEFAULT_REDDIT_GET_ME_SLUG, 'override replaces the default');
});

// ── 6. Fail-safe: must return null, never invent a username ───────────────────

test('unsuccessful top-level result → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: false, error: 'unauthorized', data: null },
  });
  const result = await resolveRedditUser(gateway, fakeConfig(), 'ca_reddit_1');
  assert.equal(result, null);
});

test('successful result but data is null → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: null },
  });
  const result = await resolveRedditUser(gateway, fakeConfig(), 'ca_reddit_1');
  assert.equal(result, null);
});

test('successful result but data has no name field → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { id: 't2_abc', link_karma: 500 } },
  });
  const result = await resolveRedditUser(gateway, fakeConfig(), 'ca_reddit_1');
  assert.equal(result, null);
});

test('successful result but data.data has no name field → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: { id: 't2_abc', link_karma: 500 } } },
  });
  const result = await resolveRedditUser(gateway, fakeConfig(), 'ca_reddit_1');
  assert.equal(result, null);
});

test('successful result but name is blank string → null', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: { name: '   ' } } },
  });
  const result = await resolveRedditUser(gateway, fakeConfig(), 'ca_reddit_1');
  assert.equal(result, null);
});
