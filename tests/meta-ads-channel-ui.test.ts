import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import MetaAdsChannel from '../frontend/integrations/meta-ads-channel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const account = { id: 'act_123', name: 'Test account', currency: 'USD' };
const connected = { connected: true, connectionId: '19', accounts: [account], accountId: 'act_123' };

async function mount(t: any, props: { performance?: boolean; period?: string } = {}, data: unknown = connected) {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(data);
  });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(MetaAdsChannel, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return { renderer, calls };
}

test('settings renders a separate ad account picker and submits verified account/connection identifiers', async t => {
  const { renderer, calls } = await mount(t);
  const select = renderer.root.findByType('select');
  assert.equal(select.props.value, 'act_123');
  assert.equal(select.props.id, 'meta-ads-account');
  const save = renderer.root.findAllByType('button').find(button => button.children.includes('Confirm ad account'))!;
  await act(async () => save.props.onClick());
  const mutation = calls.find(call => call.init.method === 'POST')!;
  assert.equal(mutation.url, '/api/integrations/meta-ads');
  assert.deepEqual(JSON.parse(mutation.init.body as string), { accountId: 'act_123', connectionId: '19' });
  assert.equal(calls.some(call => /boost|campaign.*create/.test(call.url)), false);
});

test('insights displays campaign spend separately from organic results with the chosen period', async t => {
  const { renderer, calls } = await mount(t, { performance: true, period: 'week' }, {
    ...connected, currency: 'USD', campaigns: [{ id: '1', name: 'Spring', status: 'PAUSED', spend: 12.5, impressions: 100, clicks: null }],
  });
  const url = new URL(calls[0].url, 'https://aries.example.com');
  assert.equal(url.searchParams.get('period'), '7day');
  assert.equal(url.searchParams.get('performance'), '1');
  const text = JSON.stringify(renderer.toJSON());
  assert.match(text, /Spring/);
  assert.match(text, /Spend \(USD\)/);
  assert.match(text, /12.5/);
  assert.match(text, /Unavailable/);
  assert.equal(renderer.root.findAllByType('button').length, 0);
});

test('disconnected insights offers settings, not a spend action or invented zero metrics', async t => {
  const { renderer } = await mount(t, { performance: true }, { connected: false, accounts: [], accountId: null });
  assert.equal(renderer.root.findByType('a').props.href, '/dashboard/settings/channel-integrations');
  assert.equal(renderer.root.findAllByType('table').length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /Read-only/);
});
