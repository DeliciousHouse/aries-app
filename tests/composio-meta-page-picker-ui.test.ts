import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import MetaAccountPicker from '@/frontend/integrations/meta-account-picker';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

for (const pages of [
  [{ id: 'one', name: 'Only page' }],
  [{ id: 'one', name: 'First page' }, { id: 'chosen', name: 'Chosen business' }],
]) {
  test(`picker requires explicit confirmation for ${pages.length} available pages`, async () => {
    const original = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let selected = 0;
    let renderer!: TestRenderer.ReactTestRenderer;
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(init?.method === 'POST' ? { status: 'ok' } : { connectedAccountId: 'ca_current', pages });
    }) as typeof fetch;
    try {
      await act(async () => { renderer = TestRenderer.create(React.createElement(MetaAccountPicker, { platform: 'facebook', required: true, onSelected: async () => { selected++; }, onReconnect: () => {} })); });
      assert.equal(calls.length, 1, 'listing alone does not persist a selection');
      const select = renderer.root.findByType('select');
      const confirm = () => renderer.root.findAllByType('button').find(b => b.children.includes('Confirm page'))!;
      if (pages.length > 1) {
        assert.equal(select.props.value, '');
        assert.equal(confirm().props.disabled, true);
        await act(async () => { select.props.onChange({ target: { value: 'chosen' } }); });
      } else {
        assert.equal(select.props.value, 'one', 'sole page name must be visible before confirmation');
      }
      assert.equal(selected, 0);
      await act(async () => { await confirm().props.onClick(); });
      assert.equal(selected, 1);
      assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { pageId: pages.length > 1 ? 'chosen' : 'one', connectedAccountId: 'ca_current' });
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      globalThis.fetch = original;
    }
  });
}

for (const body of [
  { connections: [] },
  { connectedAccountId: 'ca_current', pages: null },
  { connectedAccountId: 'ca_current', pages: [{ name: 'Missing id' }] },
]) {
  test(`malformed page response stays retryable: ${JSON.stringify(body)}`, async (t) => {
    let reads = 0;
    let renderer!: TestRenderer.ReactTestRenderer;
    t.mock.method(globalThis, 'fetch', async () => Response.json(++reads === 1 ? body : {
      connectedAccountId: 'ca_current', pages: [{ id: 'one', name: 'Only page' }],
    }));
    t.after(async () => { if (renderer) await act(async () => renderer.unmount()); });
    await act(async () => { renderer = TestRenderer.create(React.createElement(MetaAccountPicker, {
      platform: 'facebook', required: true, onSelected: async () => {}, onReconnect: () => {},
    })); });
    assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), 'Could not load pages.');
    assert.equal(renderer.root.findAllByType('select').length, 0);
    assert.equal(renderer.root.findAllByType('button').find(b => b.children.includes('Confirm page'))!.props.disabled, true);
    await act(async () => renderer.root.findAllByType('button').find(b => b.children.includes('Refresh pages'))!.props.onClick());
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
    assert.equal(renderer.root.findByType('select').props.value, 'one');
  });
}

test('Change page re-lists; failed save keeps the chooser and does not claim success', async () => {
  const original = globalThis.fetch;
  let reads = 0;
  let selected = 0;
  let renderer!: TestRenderer.ReactTestRenderer;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === 'POST') return Response.json({ message: 'Connection changed' }, { status: 409 });
    reads++;
    return Response.json({ connectedAccountId: 'ca_current', pages: [{ id: 'new', name: 'New page' }] });
  }) as typeof fetch;
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(MetaAccountPicker, { platform: 'facebook', required: false, onSelected: async () => { selected++; }, onReconnect: () => {} })); });
    assert.equal(reads, 0);
    await act(async () => renderer.root.findByType('button').props.onClick());
    assert.equal(reads, 1);
    await act(async () => renderer.root.findAllByType('button').find(b => b.children.includes('Refresh pages'))!.props.onClick());
    assert.equal(reads, 2);
    await act(async () => renderer.root.findByType('select').props.onChange({ target: { value: 'new' } }));
    await act(async () => renderer.root.findAllByType('button').find(b => b.children.includes('Confirm page'))!.props.onClick());
    assert.equal(selected, 0);
    assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), 'Connection changed');
    assert.match(JSON.stringify(renderer.toJSON()), /Edit settings/);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    globalThis.fetch = original;
  }
});
