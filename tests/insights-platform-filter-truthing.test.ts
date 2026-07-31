/**
 * AA-113 (S5-4) — platform filter truthing.
 *
 * The channel chips were a static array carrying a **TikTok** chip with no
 * TikTok adapter behind it (`backend/insights/platforms/registry.ts` has no
 * tiktok, and `backend/insights/adapters/` has no tiktok directory), so
 * selecting it could only ever return nothing. The same array omitted X,
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
import { isPlatformInsightsEnabled } from '../backend/insights/sync/adapter-factory';
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
// The dead chip is gone
// ---------------------------------------------------------------------------

test('no TikTok chip is rendered, because no TikTok adapter exists', async () => {
  // Even if a caller somehow asked for every registry platform, TikTok is not
  // one of them — the registry is the source of truth.
  const root = await renderFilters(SUPPORTED_PLATFORMS as unknown as readonly Platform[]);
  const labels = chipLabels(root);

  assert.ok(!labels.some((l) => /tiktok/i.test(l)), `TikTok chip must be gone; got ${labels.join(', ')}`);
  assert.ok(
    !(SUPPORTED_PLATFORMS as readonly string[]).includes('tiktok'),
    'the backend registry must not claim tiktok support',
  );
});

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

test('isPlatformInsightsEnabled rejects tiktok on every env, so no chip can appear for it', () => {
  const permissive = {
    COMPOSIO_ENABLED: 'true',
    ANALYTICS_PROVIDER: 'composio',
    ARIES_X_ENABLED: 'true',
    ARIES_YOUTUBE_ENABLED: 'true',
    ARIES_REDDIT_ENABLED: 'true',
    ARIES_LINKEDIN_ENABLED: 'true',
    ARIES_TIKTOK_ENABLED: 'true',
  } as unknown as NodeJS.ProcessEnv;

  // Everything real turns on...
  assert.equal(isPlatformInsightsEnabled('x', permissive), true);
  assert.equal(isPlatformInsightsEnabled('reddit', permissive), true);
  assert.equal(isPlatformInsightsEnabled('linkedin', permissive), true);
  // ...but tiktok stays off even with its own flag set, because no adapter exists.
  assert.equal(isPlatformInsightsEnabled('tiktok', permissive), false);
});
