import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import PagePickerForm from '@/app/onboarding/connect/meta/select-page/PagePickerForm';

for (const pages of [
  [{ id: 'p1', name: 'North shop', hasInstagram: false }],
  [{ id: 'p1', name: 'North shop', hasInstagram: false }, { id: 'p2', name: 'South shop', hasInstagram: true }],
]) {
  test(`shared form requires explicit named confirmation with ${pages.length} choices`, async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const saved: string[] = [];
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(PagePickerForm, {
      pages, onSelect: async (id: string) => { saved.push(id); },
    } as any)); });
    try {
      assert.equal(root.root.findByType('button').props.disabled, true);
      const id = pages.at(-1)!.id;
      await act(async () => { root.root.findByProps({ value: id }).props.onChange(); });
      assert.equal(root.root.findByType('button').props.disabled, false);
      await act(async () => { await root.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
      assert.deepEqual(saved, [id]);
    } finally { await act(async () => root.unmount()); }
  });
}
