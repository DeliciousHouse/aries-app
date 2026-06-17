import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveFacebookManagedPage,
  DEFAULT_LIST_MANAGED_PAGES_SLUG,
} from '@/backend/integrations/composio/facebook-page-resolver';
import { fakeConfig, fakeGateway } from './composio/helpers';

test('resolves the first managed page (deterministic) and reports the managed count', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: [{ id: 'P1', name: 'Primary' }, { id: 'P2', name: 'Second' }] },
    },
  });
  const page = await resolveFacebookManagedPage(gateway, fakeConfig({ actions: {} }), 'ca_1');
  assert.deepEqual(page, { pageId: 'P1', pageName: 'Primary', managedCount: 2 });
  assert.equal(gateway.calls[0].slug, DEFAULT_LIST_MANAGED_PAGES_SLUG);
  assert.equal(gateway.calls[0].options.connectedAccountId, 'ca_1');
  assert.equal((gateway.calls[0].options.arguments as Record<string, unknown>).user_id, 'me');
});

test('honors the COMPOSIO_FACEBOOK_LIST_PAGES_ACTION override slug', async () => {
  const gateway = fakeGateway({
    executeResult: { successful: true, error: null, data: { data: [{ id: 'P1', name: 'X' }] } },
  });
  await resolveFacebookManagedPage(gateway, fakeConfig({ actions: { list_pages: 'CUSTOM_PAGES' } }), 'ca_1');
  assert.equal(gateway.calls[0].slug, 'CUSTOM_PAGES');
});

test('returns null on an unsuccessful tool call (never invents a page)', async () => {
  const gateway = fakeGateway({ executeResult: { successful: false, error: 'scope missing', data: null } });
  const page = await resolveFacebookManagedPage(gateway, fakeConfig({ actions: {} }), 'ca_1');
  assert.equal(page, null);
});

test('returns null when no managed pages are returned (empty data)', async () => {
  const gateway = fakeGateway({ executeResult: { successful: true, error: null, data: { data: [] } } });
  const page = await resolveFacebookManagedPage(gateway, fakeConfig({ actions: {} }), 'ca_1');
  assert.equal(page, null);
});

test('skips entries without a string id and picks the first valid one', async () => {
  const gateway = fakeGateway({
    executeResult: {
      successful: true,
      error: null,
      data: { data: [{ name: 'no id' }, { id: 'P9', name: 'Valid' }] },
    },
  });
  const page = await resolveFacebookManagedPage(gateway, fakeConfig({ actions: {} }), 'ca_1');
  assert.equal(page?.pageId, 'P9');
});
