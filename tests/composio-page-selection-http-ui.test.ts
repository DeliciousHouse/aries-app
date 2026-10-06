import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { handleComposioPages } from '@/app/api/integrations/composio/handlers';
import { notConnectedAccount } from '@/backend/integrations/composio/connection-store';
import type { AccountConnectionProvider } from '@/backend/integrations/providers/interfaces';
import ComposioConnectionsScreen from '@/frontend/integrations/composio-connections-screen';
import ComposioPageSelection from '@/frontend/integrations/composio-page-selection';

const pages = [{ id: 'p1', name: 'North shop', hasInstagram: false }, { id: 'p2', name: 'South shop', hasInstagram: true }];
const tenant = async () => ({ tenantId: '42', userId: 'operator', role: 'tenant_admin' as const, tenantSlug: 'test' });

test('picker HTTP derives scope from session, rejects malformed input and never exposes credentials', async () => {
  const calls: unknown[] = [];
  const provider: AccountConnectionProvider = {
    kind: 'composio', createConnectLink: async () => { throw new Error('unused'); },
    listConnections: async () => [], getConnection: async () => null,
    disconnectConnection: async () => ({ disconnected: false }), refreshConnectionStatus: async () => null,
    listAccountPages: async (...args) => { calls.push(args); return { connectedAccountId: 'ca_current', pages }; },
    selectAccountPage: async (...args) => { calls.push(args); },
  };
  const get = await handleComposioPages(new Request('https://example.com/pages'), 'facebook', tenant, provider);
  assert.deepEqual(await get.json(), { status: 'ok', connectedAccountId: 'ca_current', pages });
  assert.deepEqual(calls.pop(), ['aries-tenant-42', 'facebook', { tenantId: '42' }]);
  const post = (body: unknown) => new Request('https://example.com/pages', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await handleComposioPages(post({ pageId: '' }), 'facebook', tenant, provider)).status, 400);
  assert.equal((await handleComposioPages(post({ pageId: 'p2', connectedAccountId: 'ca_current', tenantId: 'attacker' }), 'facebook', tenant, provider)).status, 200);
  assert.deepEqual(calls.pop(), ['aries-tenant-42', 'facebook', 'ca_current', 'p2', { tenantId: '42' }]);
  assert.equal((await handleComposioPages(post({}), 'meta', tenant, provider)).status, 400);
  assert.equal((await handleComposioPages(post({}), 'facebook', async () => { throw new Error('Authentication required'); }, provider)).status, 403);
  provider.listAccountPages = async () => { throw new Error('synthetic confidential upstream detail'); };
  const failed = await handleComposioPages(new Request('https://example.com/pages'), 'facebook', tenant, provider);
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /confidential/);
});

test('malformed page responses fail closed in the UI rather than enabling confirmation', async t => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  for (const pages of [undefined, [null], [{ id: '', name: 'Shop', hasInstagram: false }]]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'ok', connectedAccountId: 'ca_current', pages }));
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(ComposioPageSelection, { platform: 'facebook', onSaved: async () => {} })); });
    assert.ok(root.root.findByProps({ role: 'alert' }));
    assert.equal(root.root.findAllByType('form').length, 0);
    await act(async () => root.unmount());
    t.mock.restoreAll();
  }
});

for (const platform of ['facebook', 'instagram'] as const) {
  test(`Connections displays confirmed ${platform} identity, changes it through the shared form, and reloads`, async t => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let selected = 'p1';
    let root!: ReturnType<typeof create>;
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      requests.push(String(url));
      if (String(url).endsWith('/pages')) {
        if (init?.method === 'POST') {
          assert.deepEqual(JSON.parse(String(init.body)), { pageId: 'p2', connectedAccountId: 'ca_current' });
          selected = 'p2';
          return Response.json({ status: 'ok' });
        }
        return Response.json({ status: 'ok', connectedAccountId: 'ca_current', pages });
      }
      return Response.json({ status: 'ok', composioEnabled: true, publishProvider: 'composio', analyticsProvider: 'composio', connections: [{
        ...notConnectedAccount('42', 'aries-tenant-42', platform, 'composio'), status: 'connected', connectedAccountId: 'ca_current',
        externalAccountId: selected, externalAccountName: pages.find(p => p.id === selected)!.name, prerequisites: [], lastSuccessfulPostAt: null,
      }] });
    });
    await act(async () => { root = create(React.createElement(ComposioConnectionsScreen)); });
    try {
      assert.ok(JSON.stringify(root.toJSON()).includes('North shop'));
      const label = platform === 'facebook' ? 'Change page' : 'Change account';
      await act(async () => { root.root.findAllByType('button').find(b => b.children.join('') === label)!.props.onClick(); });
      assert.ok(root.root.findByType('form'));
      assert.equal(root.root.findAllByType('button').find(b => String(b.children).includes('Use this'))!.props.disabled, true);
      if (platform === 'facebook') assert.match(JSON.stringify(root.toJSON()), /Edit settings/);
      await act(async () => root.root.findByProps({ value: 'p2' }).props.onChange());
      await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
      assert.ok(JSON.stringify(root.toJSON()).includes('South shop'));
      assert.equal(root.root.findAllByType('form').length, 0);
      assert.equal(requests.filter(r => r.endsWith('/pages')).length, 2);
    } finally { await act(async () => root.unmount()); }
  });
}

for (const platform of ['linkedin', 'x'] as const) {
  test(`${platform} shows Post as, Confirm/Disconnect and never confirms until clicked`, async t => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const oldFlag = process.env[platform === 'x' ? 'ARIES_X_ENABLED' : 'ARIES_LINKEDIN_ENABLED'];
    const flag = platform === 'x' ? 'ARIES_X_ENABLED' : 'ARIES_LINKEDIN_ENABLED';
    process.env[flag] = 'true';
    t.after(() => { if (oldFlag === undefined) delete process.env[flag]; else process.env[flag] = oldFlag; });
    const calls: unknown[][] = [];
    let confirmed = false;
    const identity = platform === 'x' ? 'shop_owner' : 'urn:li:person:member';
    const provider: AccountConnectionProvider = {
      kind: 'composio', createConnectLink: async () => { throw new Error('unused'); },
      listConnections: async () => [], getConnection: async () => null,
      disconnectConnection: async () => ({ disconnected: true }), refreshConnectionStatus: async () => null,
      listAccountPages: async (...args) => { calls.push(args); return { connectedAccountId: 'ca_current', pages: [{ id: identity, name: 'Shop Owner', hasInstagram: false }] }; },
      selectAccountPage: async (...args) => { calls.push(args); confirmed = true; },
    };
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/pages')) return handleComposioPages(new Request(`https://example.com${url}`, init), platform, tenant, provider);
      return Response.json({ status: 'ok', composioEnabled: true, connections: [{
        ...notConnectedAccount('42', 'aries-tenant-42', platform, 'composio'),
        connectedAccountId: 'ca_current', status: confirmed ? 'connected' : 'unconfirmed',
        externalAccountId: confirmed ? identity : null,
      }] });
    });
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(ComposioConnectionsScreen)); });
    try {
      assert.equal(confirmed, false);
      assert.match(JSON.stringify(root.toJSON()), /Post as Shop Owner\?/);
      assert.match(JSON.stringify(root.toJSON()), /Unconfirmed/);
      assert.ok(root.root.findAllByType('button').find(b => b.children.join('') === 'Disconnect'));
      const confirm = root.root.findAllByType('button').find(b => b.children.join('') === 'Confirm')!;
      assert.equal(confirm.props.disabled, false);
      assert.match(confirm.props.className, /bg-rose-600/);
      await act(async () => root.root.findByType('form').props.onSubmit({ preventDefault() {} }));
      assert.deepEqual(calls.at(-1), ['aries-tenant-42', platform, 'ca_current', identity, { tenantId: '42' }]);
      assert.equal(confirmed, true);
      assert.match(JSON.stringify(root.toJSON()), /Connected and ready/);
      assert.equal(root.root.findAllByType('form').length, 0);
    } finally { await act(async () => root.unmount()); }
  });
}
