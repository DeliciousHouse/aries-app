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
    connectedAccountId: 'ca_current',
    externalAccountId: status === 'connected' ? `page-${tenantId}` : null,
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
  globals.window = Object.assign(new EventTarget(), { location: { search: '', href: '' } });
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
  assert.match(text(root), /Connection attempt expired — try again/);
  assert.equal(posts, 0, 'reauthorization is never started without a click');
  const reconnect = root.root.findByProps({ 'aria-label': 'Reconnect Facebook Page' });
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
  assert.equal(root.root.findAllByType('h2').length, 1, 'Meta Ads remains visible while connection data loads');
  assert.match(text(root), /Meta Ads.*Coming soon/);
  const ads = root.root.find((node) => node.type === 'button' && node.children.includes('Connect Meta Ads'));
  assert.equal(ads.props.disabled, true);
  assert.equal(ads.props.onClick, undefined);
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
  assert.match(text(root), /Waiting for you to finish on Facebook/);
  assert.equal(root.root.findByProps({ 'aria-label': 'Finish connecting Facebook Page' }).props.disabled, false);
  const check = root.root.find((node) => node.type === 'button' && node.children.includes('Check again'));
  await act(async () => { check.props.onClick(); });
  assert.match(text(root), /Connected and ready/);
  assert.doesNotMatch(text(root), /Waiting for you to finish/);
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
  assert.equal(root.root.findByProps({ 'aria-label': 'Reconnect Facebook Page' }).props.disabled, true);
});

test('OAuth failures keep the operator on the page with a usable reconnect button', async (t) => {
  const root = await mount(t, async (_url, init) => init?.method === 'POST'
    ? Response.json({ message: 'Could not start the connection.' }, { status: 503 })
    : healthResponse('error'));
  assert.match(text(root), /Something went wrong/);
  const reconnect = root.root.findByProps({ 'aria-label': 'Reconnect Facebook Page' });
  await act(async () => { await reconnect.props.onClick(); });
  assert.match(text(root), /Could not start the connection/);
  assert.equal(root.root.findAllByProps({ role: 'alert' }).length, 1);
  assert.equal(reconnect.props.disabled, false);
  assert.equal(window.location.href, '');
});

test('a stale second tab refreshes on focus and visibility, ignoring hidden events and removing listeners', async t => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globals.document;
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  globals.document = doc;
  t.after(() => { globals.document = originalDocument; });
  let status: ConnectedAccount['status'] = 'connected';
  let calls = 0;
  const root = await mount(t, async () => { calls++; return healthResponse(status); });
  // mount's window stub is sufficient for location; supply event methods before
  // remounting so this test exercises real add/removeEventListener behavior.
  const win = Object.assign(new EventTarget(), { location: { search: '', href: '' } });
  await act(async () => root.unmount());
  globals.window = win;
  let second!: ReactTestRenderer;
  await act(async () => { second = create(React.createElement(ComposioConnectionsScreen)); });
  assert.match(text(second), /Connected and ready/);
  status = 'not_connected';
  await act(async () => { win.dispatchEvent(new Event('focus')); });
  assert.doesNotMatch(text(second), /Connected and ready/);
  status = 'connected';
  doc.visibilityState = 'hidden';
  const before = calls;
  await act(async () => { doc.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(calls, before);
  doc.visibilityState = 'visible';
  await act(async () => { doc.dispatchEvent(new Event('visibilitychange')); });
  assert.match(text(second), /Connected and ready/);
  await act(async () => second.unmount());
  const after = calls;
  win.dispatchEvent(new Event('focus'));
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, after);
});

for (const failStale of [false, true]) {
  test(`coalesces tab-return reads and ignores superseded ${failStale ? 'errors' : 'snapshots'} after Disconnect`, async t => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const originalDocument = globals.document;
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    globals.document = doc;
    t.after(() => { globals.document = originalDocument; });
    let calls = 0;
    let resolve!: (response: Response) => void;
    const delayed = new Promise<Response>(done => { resolve = done; });
    const root = await mount(t, async (_url, init) => {
      if (init?.method === 'DELETE') return Response.json({ disconnected: true });
      calls++;
      if (calls === 2) return delayed;
      return healthResponse(calls === 1 ? 'connected' : 'not_connected');
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      doc.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(calls, 2, 'focus and visibility must share the outstanding background refresh');
    const disconnect = root.root.find(node => node.type === 'button' && node.children.includes('Disconnect'));
    await act(async () => { await disconnect.props.onClick(); });
    assert.equal(calls, 3, 'mutation must issue a fresh read rather than reusing the old snapshot');
    assert.doesNotMatch(text(root), /Connected and ready|Loading your connections/);
    await act(async () => {
      resolve(failStale ? Response.json({ message: 'Stale failure' }, { status: 503 }) : await healthResponse('connected'));
    });
    assert.doesNotMatch(text(root), /Connected and ready|Stale failure|Loading your connections/);
    assert.equal(root.root.findAllByProps({ role: 'alert' }).length, 0);
  });
}

test('pending attempt shows explicit expiry after the bounded poll window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = await mount(t, async () => healthResponse('pending'));
  assert.match(text(root), /Waiting for you to finish on Facebook/);
  for (const delay of [2000, 5000, 10000, 20000, 40000, 60000, 80000, 90000]) {
    await act(async () => { t.mock.timers.tick(delay); });
  }
  assert.match(text(root), /Connection attempt expired — try again/);
});
