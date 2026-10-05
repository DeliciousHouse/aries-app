import { test } from 'node:test';
import assert from 'node:assert/strict';

// AA-243: the throw fixtures below are the REAL @composio/core error classes,
// constructed the way the SDK constructs them (`throw new
// ComposioToolNotFoundError(...)` from the tool-schema retrieve; `throw
// handleToolExecutionError(tool.slug, error)` from execution). Hand-rolled
// stand-ins are banned here: this codebase has shipped bugs behind green suites
// whose fixtures encoded the same wrong belief as the code under test.
import {
  ComposioToolExecutionError,
  ComposioToolNotFoundError,
  handleToolExecutionError,
} from '@composio/core';

import {
  listFacebookManagedPages,
  DEFAULT_LIST_MANAGED_PAGES_SLUG,
} from '@/backend/integrations/composio/facebook-page-resolver';
import { fakeConfig, fakeGateway } from './composio/helpers';

test('never silently chooses the first of multiple managed pages', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: [{ id: 'P1', name: 'Primary' }, { id: 'P2', name: 'Second' }] },
    },
  });
  const pages = await listFacebookManagedPages(gateway, fakeConfig({ actions: {} }), 'ca_1');
  assert.deepEqual(pages, [{ id: 'P1', name: 'Primary' }, { id: 'P2', name: 'Second' }]);
  assert.equal(gateway.calls[0].slug, DEFAULT_LIST_MANAGED_PAGES_SLUG);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_1');
  assert.equal((gateway.calls[0].options.arguments as Record<string, unknown>).user_id, 'me');
});

test('honors the COMPOSIO_FACEBOOK_LIST_PAGES_ACTION override slug', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: [{ id: 'P1', name: 'X' }] } },
  });
  await listFacebookManagedPages(gateway, fakeConfig({ actions: { list_pages: 'CUSTOM_PAGES' } }), 'ca_1');
  assert.equal(gateway.calls[0].slug, 'CUSTOM_PAGES');
});

test('returns null on an unsuccessful tool call (never invents a page)', async () => {
  const gateway = fakeGateway({ executeResult: { successful: false, error: 'scope missing', data: null } });
  const page = await listFacebookManagedPages(gateway, fakeConfig({ actions: {} }), 'ca_1');
  assert.equal(page, null);
});

test('returns an empty list when no managed pages are returned', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { data: [] } } });
  const pages = await listFacebookManagedPages(gateway, fakeConfig({ actions: {} }), 'ca_1');
  assert.deepEqual(pages, []);
});

test('lists only entries with valid string ids', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: [{ name: 'no id' }, { id: 'P9', name: 'Valid' }] },
    },
  });
  const pages = await listFacebookManagedPages(gateway, fakeConfig({ actions: {} }), 'ca_1');
  assert.deepEqual(pages, [{ id: 'P9', name: 'Valid' }]);
});

// ── AA-243: a thrown executeTool is swallowed to null, never leaked ─────────
//
// @composio/core does not convert transport failures into `successful:false` —
// it THROWS, and LiveComposioGateway.executeTool does not catch. The resolver's
// fail-safe contract ("returns null ... never invents a Page") must hold for
// the thrown shape too, exactly like resolveInstagramAccount.

test('AA-243: returns null when executeTool throws ComposioToolNotFoundError (tool-schema retrieve failure)', async () => {
  const gateway = fakeGateway({
    onExecute: () => {
      // Verbatim SDK construction: `throw new ComposioToolNotFoundError(
      //   `Unable to retrieve tool with slug ${slug}`, { cause: error })`.
      throw new ComposioToolNotFoundError(
        `Unable to retrieve tool with slug ${DEFAULT_LIST_MANAGED_PAGES_SLUG}`,
        { cause: new Error('getaddrinfo ENOTFOUND backend.composio.dev') },
      );
    },
  });
  const page = await listFacebookManagedPages(gateway, fakeConfig({ actions: {} }), 'ca_1');
  assert.equal(page, null);
  assert.equal(gateway.calls.length, 1, 'the tool call was attempted before the throw');
});

test('AA-243: returns null when executeTool throws the handleToolExecutionError-produced error (execution transport failure)', async () => {
  // Build the error EXACTLY as the SDK does at its execution throw site:
  // `throw handleToolExecutionError(tool.slug, error)`.
  const thrown = handleToolExecutionError(DEFAULT_LIST_MANAGED_PAGES_SLUG, new Error('socket hang up'));
  assert.ok(
    thrown instanceof ComposioToolExecutionError,
    'fixture sanity: the factory must produce the real SDK class',
  );
  const gateway = fakeGateway({
    onExecute: () => {
      throw thrown;
    },
  });
  const page = await listFacebookManagedPages(gateway, fakeConfig({ actions: {} }), 'ca_1');
  assert.equal(page, null);
});
