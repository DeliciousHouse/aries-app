import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import ComposioConnectionsScreen from '@/frontend/integrations/composio-connections-screen';
import { handleComposioList } from '@/app/api/integrations/composio/handlers';
import { notConnectedAccount } from '@/backend/integrations/composio/connection-store';
import type { AccountConnectionProvider } from '@/backend/integrations/providers/interfaces';
import type { ConnectedAccount } from '@/backend/integrations/providers/types';

async function healthResponse(status: ConnectedAccount['status'], tenantId = '61') {
  const account = {
    ...notConnectedAccount(tenantId, `aries-tenant-${tenantId}`, 'facebook', 'composio'),
    status,
    externalAccountName: `Workspace ${tenantId} Page`,
  };
  const provider: AccountConnectionProvider = {
    kind: 'composio',
    async listConnections(_user, options) {
      assert.equal(options?.tenantId, tenantId);
      return [account];
    },
    async refreshConnectionStatus() { return account; },
    async getConnection() { return account; },
    async createConnectLink() { throw new Error('not used by list'); },
    async disconnectConnection() { return { disconnected: false }; },
  };
  return handleComposioList(
    async () => ({ userId: 'user', tenantId, tenantSlug: `workspace-${tenantId}`, role: 'tenant_admin' }),
    provider,
    { query: async (_sql, params) => {
      assert.deepEqual(params, [Number(tenantId)]);
      return { rows: [{ platform: 'facebook', last_successful_post_at: '2026-08-11T09:30:00.000Z' }] };
    } },
  );
}

async function mount(t: TestContext, fetcher: typeof fetch) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalWindow = globals.window;
  const originalAct = globals.IS_REACT_ACT_ENVIRONMENT;
  const originalEnabled = process.env.COMPOSIO_ENABLED;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.window = { location: { search: '', href: '' } };
  process.env.COMPOSIO_ENABLED = 'true';
  t.mock.method(globalThis, 'fetch', fetcher);
  let root!: ReactTestRenderer;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    globals.window = originalWindow;
    globals.IS_REACT_ACT_ENVIRONMENT = originalAct;
    if (originalEnabled === undefined) delete process.env.COMPOSIO_ENABLED;
    else process.env.COMPOSIO_ENABLED = originalEnabled;
  });
  await act(async () => { root = create(React.createElement(ComposioConnectionsScreen)); });
  return root;
}

function text(root: ReactTestRenderer): string {
  return root.root.findAll((node) => node.children.some((child) => typeof child === 'string'))
    .flatMap((node) => node.children.filter((child) => typeof child === 'string')).join(' ');
}

for (const tenantId of ['61', '12']) {
  test(`renders workspace ${tenantId} health and last post from the real list handler`, async (t) => {
    const root = await mount(t, async (url, init) => {
      assert.equal(url, '/api/integrations/composio');
      assert.equal(init?.cache, 'no-store');
      return healthResponse('connected', tenantId);
    });
    assert.match(text(root), new RegExp(`Workspace ${tenantId} Page`));
    assert.match(text(root), /Connected and ready/);
    assert.match(text(root), /Last successful post/);
    const timestamp = '2026-08-11T09:30:00.000Z';
    assert.equal(root.root.findByType('time').props.dateTime, timestamp);
    assert.equal(root.root.findByType('time').children.join(''),
      new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
    assert.match(text(root), /No successful posts yet/);
    assert.doesNotMatch(text(root), /Reconnect Facebook/);
  });
}

test('reauthorization CTA starts the existing platform OAuth flow and follows its URL', async (t) => {
  const connectUrl = 'https://composio.example/connect/tenant-61-facebook';
  let reauthorizationPath = '';
  let posts = 0;
  const root = await mount(t, async (url, init) => {
    if (init?.method === 'POST') {
      posts += 1;
      assert.equal(url, reauthorizationPath);
      assert.deepEqual(JSON.parse(String(init.body)), { requestedCapability: 'full' });
      return Response.json({ connectUrl });
    }
    const response = await healthResponse('reauthorization_required');
    const body = await response.clone().json();
    reauthorizationPath = body.connections.find((conn: ConnectedAccount) => conn.platform === 'facebook').reauthorizationPath;
    return response;
  });
  assert.match(text(root), /Please reconnect/);
  assert.equal(posts, 0, 'reauthorization is never started without a click');
  const reconnect = root.root.findByProps({ 'aria-label': 'Reconnect Facebook' });
  assert.equal(reconnect.props.disabled, false);
  await act(async () => { await reconnect.props.onClick(); });
  assert.equal(posts, 1);
  assert.equal(window.location.href, connectUrl);
});

test('announces loading then renders an empty workspace without inventing connections', async (t) => {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>((done) => { resolve = done; });
  const root = await mount(t, () => response);
  assert.match(root.root.findByProps({ role: 'status' }).children.join(''), /Loading your connections/);
  assert.equal(root.root.findAllByType('h2').length, 0);
  await act(async () => { resolve(Response.json({ composioEnabled: true, connections: [] })); });
  assert.match(text(root), /No accounts connected yet/);
  assert.doesNotMatch(text(root), /Loading your connections|Connected and ready/);
});

test('failed health reads show an alert and can be retried instead of looking empty', async (t) => {
  let calls = 0;
  const root = await mount(t, async () => ++calls === 1
    ? Response.json({ message: 'Could not load connections.' }, { status: 503 })
    : healthResponse('connected'));
  assert.equal(root.root.findAllByProps({ role: 'alert' }).length, 1);
  assert.doesNotMatch(text(root), /No accounts connected yet|Connected and ready/);
  const retry = root.root.find((node) => node.type === 'button' && node.children.includes('Try again'));
  await act(async () => { await retry.props.onClick(); });
  assert.match(text(root), /Connected and ready/);
  assert.equal(root.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('pending health can be checked again and updates from fresh API data', async (t) => {
  let calls = 0;
  const root = await mount(t, async () => healthResponse(++calls === 1 ? 'pending' : 'connected'));
  assert.match(text(root), /Finishing connecting/);
  assert.equal(root.root.findByProps({ 'aria-label': 'Finish connecting Facebook' }).props.disabled, false);
  const check = root.root.find((node) => node.type === 'button' && node.children.includes('Check again'));
  await act(async () => { check.props.onClick(); });
  assert.match(text(root), /Connected and ready/);
  assert.doesNotMatch(text(root), /Finishing connecting/);
});

test('missing and invalid history stays unavailable rather than claiming no successful posts', async (t) => {
  const root = await mount(t, async () => Response.json({ composioEnabled: true, connections: [
    { platform: 'facebook', status: 'connected', capabilities: null },
    { platform: 'instagram', status: 'connected', capabilities: null, lastSuccessfulPostAt: 'bad-date' },
  ] }));
  assert.equal(root.root.findAllByType('time').length, 0);
  assert.equal(text(root).match(/History unavailable/g)?.length, 2);
  assert.doesNotMatch(text(root), /Invalid Date|No successful posts yet/);
});

test('unconfigured workspaces cannot start reauthorization', async (t) => {
  const root = await mount(t, async () => {
    const body = await (await healthResponse('reauthorization_required')).json();
    return Response.json({ ...body, composioEnabled: false });
  });
  assert.match(text(root), /aren’t turned on for this workspace/);
  assert.equal(root.root.findByProps({ 'aria-label': 'Reconnect Facebook' }).props.disabled, true);
});

test('OAuth failures keep the operator on the page with a usable reconnect button', async (t) => {
  const root = await mount(t, async (_url, init) => init?.method === 'POST'
    ? Response.json({ message: 'Could not start the connection.' }, { status: 503 })
    : healthResponse('error'));
  assert.match(text(root), /Something went wrong/);
  const reconnect = root.root.findByProps({ 'aria-label': 'Reconnect Facebook' });
  await act(async () => { await reconnect.props.onClick(); });
  assert.match(text(root), /Could not start the connection/);
  assert.equal(root.root.findAllByProps({ role: 'alert' }).length, 1);
  assert.equal(reconnect.props.disabled, false);
  assert.equal(window.location.href, '');
});
