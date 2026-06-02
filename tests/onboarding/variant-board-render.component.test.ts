/**
 * Render verification for the first-post variant board: actually mounts
 * <VariantBoard> in jsdom (React 19 + @testing-library/react), drives the
 * happy path against a mocked board API, and asserts the board renders 3 cards
 * with star ratings + pick controls and that a pick navigates to the dashboard.
 * This is the automated proxy for "the 3-variant board renders + pick works".
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding/variant-board-render.component.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installJsdom } from '../helpers/jsdom-env';

// DOM must exist before React / @testing-library load.
installJsdom();

import React from 'react';

import { VariantBoard } from '../../frontend/aries-v1/variant-board';

type FetchCall = { url: string; method: string; body: Record<string, unknown> | undefined };

const READY_BOARD = {
  batch_id: 'vbatch_test',
  slot_index: 0,
  board_ready: true,
  picked_variant_index: null,
  picked_creative_id: null,
  abandoned: false,
  cards: [
    { variant_index: 0, creative_id: 'c0', served_asset_ref: '/api/internal/hermes/media/c0', job_id: 'mkt_0' },
    { variant_index: 1, creative_id: 'c1', served_asset_ref: '/api/internal/hermes/media/c1', job_id: 'mkt_1' },
    { variant_index: 2, creative_id: 'c2', served_asset_ref: '/api/internal/hermes/media/c2', job_id: 'mkt_2' },
  ],
};

function installFetch(handler: (call: FetchCall) => { ok?: boolean; status?: number; json: unknown }): FetchCall[] {
  const calls: FetchCall[] = [];
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    const r = handler({ url, method, body });
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json } as never;
  };
  return calls;
}

async function mountBoard() {
  const { render } = await import('@testing-library/react');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const pushed: string[] = [];
  const router = {
    push: (u: string) => pushed.push(u),
    replace() {},
    prefetch() {},
    back() {},
    forward() {},
    refresh() {},
  };
  const utils = render(
    React.createElement(
      AppRouterContext.Provider as never,
      { value: router as never },
      React.createElement(VariantBoard, { batchId: 'vbatch_test' }),
    ),
  );
  return { utils, pushed };
}

test('VariantBoard renders 3 cards (image + stars + pick), and a pick navigates to the dashboard', async () => {
  const { fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  installFetch((call) => {
    if (call.method === 'GET') return { json: { status: 'ok', board: READY_BOARD } };
    if (call.url.includes('/pick')) return { json: { status: 'ok', finalizedJobId: 'mkt_1', pickedVariantIndex: 1 } };
    return { json: { status: 'ok' } };
  });

  const { utils, pushed } = await mountBoard();

  // Board renders: one "Pick this post" button + one star group per card.
  const pickButtons = await utils.findAllByRole('button', { name: /Pick this post/i });
  assert.equal(pickButtons.length, 3, 'three variant cards rendered');
  assert.ok(utils.getAllByRole('group').length >= 3, 'a star-rating group per card');
  assert.equal(utils.getAllByRole('img').length, 3, 'each card shows its generated image');

  // Rate then pick the second variant → POST /pick → navigate to its dashboard.
  const stars = utils.getAllByRole('button', { name: /star/i });
  fireEvent.click(stars[0]); // a star on the first card (no crash, sets state)
  fireEvent.click(pickButtons[1]);
  await waitFor(() => assert.equal(pushed.length, 1, 'navigates exactly once on pick'));
  assert.equal(pushed[0], '/dashboard/social-content/mkt_1?welcome=1');
  cleanup();
});

test('VariantBoard shows the generating state with N-of-3 progress when not ready', async () => {
  const { findByText, cleanup } = (await import('@testing-library/react'));
  installFetch(() => ({
    json: { status: 'ok', board: { ...READY_BOARD, board_ready: false, cards: [READY_BOARD.cards[0]] } },
  }));
  const { utils } = await mountBoard();
  await utils.findByText(/Generating your first posts/i);
  await utils.findByText(/1 of 3 ready/i);
  void findByText;
  cleanup();
});

test('VariantBoard auto-navigates to the dashboard when the board is already picked', async () => {
  const { waitFor, cleanup } = await import('@testing-library/react');
  installFetch(() => ({
    json: {
      status: 'ok',
      board: { ...READY_BOARD, picked_variant_index: 2, picked_creative_id: 'c2' },
    },
  }));
  const { pushed } = await mountBoard();
  await waitFor(() => assert.equal(pushed.length, 1, 'a resolved board sends the user to the dashboard'));
  assert.equal(pushed[0], '/dashboard/social-content/mkt_2?welcome=1');
  cleanup();
});
