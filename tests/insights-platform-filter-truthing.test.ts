/**
 * AA-113 (S5-4) — platform filter truthing.
 *
 * The channel chips were a static array that could carry a chip with no adapter
 * behind it (so selecting it could only ever return nothing) while omitting X,
 * Reddit and LinkedIn, which DO have adapters.
 *
 * Chips are now derived from `isPlatformInsightsEnabled` — the same predicate
 * the sync adapter factory uses — so a chip exists exactly when an adapter can
 * produce data for it.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-platform-filter-truthing.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import { InsightsFilters } from '../frontend/insights/InsightsFilters';
import { platformLabel, platformColor } from '../frontend/insights/tokens';
import { SUPPORTED_PLATFORMS } from '../backend/insights/platforms/registry';
import type { Platform } from '../frontend/insights/types';

type Renderer = import('react-test-renderer').ReactTestRenderer;

async function renderFilters(enabledPlatforms: readonly Platform[]): Promise<Renderer> {
  const { act, create } = await import('react-test-renderer');
  let root!: Renderer;
  await act(async () => {
    root = create(
      React.createElement(InsightsFilters, {
        period: '90day',
        platform: 'all',
        onPeriodChange: () => {},
        onPlatformChange: () => {},
        enabledPlatforms,
      }),
    );
  });
  return root;
}

/** Labels of the rendered channel chips, in order. */
function chipLabels(root: Renderer): string[] {
  const group = root.root.findAll(
    (node) => node.type === 'div' && node.props['aria-label'] === 'Channel filter',
  )[0];
  return group.findAllByType('button').map((button) => {
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') { strings.push(value); return; }
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value && typeof value === 'object') walk((value as { children?: unknown }).children);
    };
    walk(button.children);
    return strings.join('').trim();
  });
}

// ---------------------------------------------------------------------------
// Chips follow the adapter predicate
// ---------------------------------------------------------------------------

test('chips are exactly All plus the enabled platforms', async () => {
  const root = await renderFilters(['instagram', 'facebook']);
  assert.deepEqual(chipLabels(root), ['All channels', 'Instagram', 'Facebook']);
});

test('X, Reddit and LinkedIn get chips when their adapters are enabled', async () => {
  const root = await renderFilters(['instagram', 'facebook', 'x', 'reddit', 'linkedin']);
  const labels = chipLabels(root);

  for (const expected of ['X', 'Reddit', 'LinkedIn']) {
    assert.ok(labels.includes(expected), `expected a ${expected} chip; got ${labels.join(', ')}`);
  }
});

test('a deployment with no enabled adapters still renders the All chip', async () => {
  const root = await renderFilters([]);
  assert.deepEqual(chipLabels(root), ['All channels'], 'All channels must always be selectable');
});

// ---------------------------------------------------------------------------
// Drift guards — these are the point of the card
// ---------------------------------------------------------------------------

test('every registry platform has a display label and a brand colour', () => {
  for (const platform of SUPPORTED_PLATFORMS) {
    assert.ok(platformLabel[platform], `missing platformLabel entry for ${platform}`);
    assert.ok(platformColor[platform], `missing platformColor entry for ${platform}`);
  }
});

test('the frontend carries no label or colour for a platform the backend does not support', () => {
  const supported = new Set<string>([...SUPPORTED_PLATFORMS, 'all']);
  for (const key of Object.keys(platformLabel)) {
    assert.ok(supported.has(key), `platformLabel has ${key}, which the backend registry does not support`);
  }
  for (const key of Object.keys(platformColor)) {
    assert.ok(supported.has(key), `platformColor has ${key}, which the backend registry does not support`);
  }
});
