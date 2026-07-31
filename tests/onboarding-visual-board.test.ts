/**
 * Onboarding step-4 "Brand identity" visual board.
 *
 * AA-148 — every logo candidate rendered into a hard `bg-white` tile with no
 * error handling, so a candidate URL that 404s (or a white-on-transparent mark)
 * painted an indistinguishable blank white rectangle. The zero-candidates empty
 * state never fired, because the array was non-empty — the images were just
 * unusable.
 *
 * AA-149 — each font tile rendered `props.brandName` as its specimen and put
 * the family name only in the style attribute. The scraped brand_name is often
 * a full site title, so the Fonts card showed a long marketing headline and
 * nothing identifying the typeface.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/onboarding-visual-board.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import { VisualBoard, fontSpecimen } from '../frontend/aries-v1/onboarding-flow';

type Renderer = import('react-test-renderer').ReactTestRenderer;

async function renderBoard(props: {
  logoUrls: string[];
  colors: string[];
  fontFamilies: string[];
  brandName: string;
}): Promise<{ root: Renderer; act: typeof import('react-test-renderer').act }> {
  const { act, create } = await import('react-test-renderer');
  let root!: Renderer;
  await act(async () => {
    root = create(React.createElement(VisualBoard, props));
  });
  return { root, act };
}

// ---------------------------------------------------------------------------
// AA-148 — broken logo candidates
// ---------------------------------------------------------------------------

test('a logo candidate that fails to load is labelled instead of left blank', async () => {
  const { root, act } = await renderBoard({
    logoUrls: ['https://brand.example/logo-a.png', 'https://brand.example/logo-b.png'],
    colors: [],
    fontFamilies: [],
    brandName: 'Brand',
  });

  const images = root.root.findAllByType('img');
  assert.equal(images.length, 2, 'both candidates render before any failure');

  // Simulate the first candidate 404ing.
  await act(async () => {
    images[0].props.onError();
  });

  const remaining = root.root.findAllByType('img');
  assert.equal(remaining.length, 1, 'the broken candidate stops rendering an <img>');

  const text = JSON.stringify(root.toJSON());
  assert.match(text, /Logo preview unavailable/, 'the failed tile is explicitly labelled');
  assert.match(remaining[0].props.src, /logo-b/, 'the healthy candidate is untouched');
});

test('every logo candidate carries an onError handler', async () => {
  const { root } = await renderBoard({
    logoUrls: ['https://brand.example/a.png', 'https://brand.example/b.png', 'https://brand.example/c.png'],
    colors: [],
    fontFamilies: [],
    brandName: 'Brand',
  });

  for (const img of root.root.findAllByType('img')) {
    assert.equal(typeof img.props.onError, 'function', `missing onError on ${String(img.props.src)}`);
  }
});

// ---------------------------------------------------------------------------
// AA-149 — font tiles must identify the typeface, not print the headline
// ---------------------------------------------------------------------------

test('each font tile shows the family name', async () => {
  const { root } = await renderBoard({
    logoUrls: [],
    colors: [],
    fontFamilies: ['Inter', 'Playfair Display'],
    brandName: 'Sugar & Leather',
  });

  const text = JSON.stringify(root.toJSON());
  assert.match(text, /Inter/, 'family name Inter is rendered, not just used in the style attribute');
  assert.match(text, /Playfair Display/, 'family name Playfair Display is rendered');
});

test('a long scraped brand name is clamped to a type specimen', () => {
  const longName = 'Sugar & Leather — Human at the core of every campaign we build';
  const specimen = fontSpecimen(longName);

  assert.ok(specimen.length <= 22, `specimen too long: ${specimen.length} chars`);
  assert.ok(
    longName.startsWith(specimen),
    'the specimen is a prefix of the brand name, not invented text',
  );
  assert.ok(!/\s$/.test(specimen), 'specimen has no trailing whitespace');
});

test('a short brand name is used verbatim and an empty one still yields a specimen', () => {
  assert.equal(fontSpecimen('Sugar & Leather'), 'Sugar & Leather');
  assert.equal(fontSpecimen('  Acme  '), 'Acme');
  // Never render an empty type sample — the tile would look broken.
  assert.equal(fontSpecimen(''), 'Ag');
  assert.equal(fontSpecimen('   '), 'Ag');
});

test('clamping prefers a word boundary when one is available', () => {
  // 'Northwind Trading Company' -> first 22 chars is 'Northwind Trading Comp'
  // which should fall back to the last space rather than cutting mid-word.
  assert.equal(fontSpecimen('Northwind Trading Company'), 'Northwind Trading');
});
