// Regression: ISSUE-009 — Duplicate font preview cards.
// On /onboarding/start Step 4 (Brand identity), the "Fonts" sub-section
// rendered up to four preview cards that all looked identical. Root cause:
// the backend brand-kit extractor deduped font_families with a plain Set,
// so case/whitespace variants like "Arial", " Arial ", and "arial" all
// survived and were piped to the VisualBoard, which rendered one card per
// entry. The fix canonicalizes the dedup key (trim + lowercase) inside
// normalizeFontFamilies while preserving the first-seen casing.
//
// This test locks the dedup contract at the backend boundary and also
// guards the frontend render path:
//   1. normalizeBrandKitSignals collapses case/whitespace font variants.
//   2. The VisualBoard still applies fontFamily per-card (so if 2 distinct
//      fonts arrive, 2 visually-different cards render).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeBrandKitSignals } from '../backend/marketing/brand-kit';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

test('normalizeBrandKitSignals dedupes case/whitespace font variants (ISSUE-009)', () => {
  const { font_families } = normalizeBrandKitSignals({
    font_families: ['Manrope', ' Manrope ', 'manrope', 'MANROPE', 'Cormorant Garamond'],
  });

  assert.deepEqual(
    font_families,
    ['Manrope', 'Cormorant Garamond'],
    'expected case/whitespace variants to collapse to a single canonical entry per family',
  );
});

test('normalizeBrandKitSignals preserves first-seen casing on dedup (ISSUE-009)', () => {
  const { font_families } = normalizeBrandKitSignals({
    font_families: ['inter tight', 'Inter Tight', 'INTER TIGHT'],
  });

  assert.deepEqual(font_families, ['inter tight']);
});

test('normalizeBrandKitSignals still caps at 4 font families (ISSUE-009)', () => {
  const { font_families } = normalizeBrandKitSignals({
    font_families: ['Manrope', 'Inter', 'Cormorant Garamond', 'Playfair Display', 'Lora', 'Merriweather'],
  });

  assert.equal(font_families.length, 4);
  assert.deepEqual(font_families, ['Manrope', 'Inter', 'Cormorant Garamond', 'Playfair Display']);
});

test('VisualBoard Fonts cards apply per-item fontFamily style (ISSUE-009)', () => {
  // Render-layer guard: each card must set its own inline fontFamily from
  // the mapped `font` binding, not a shared parent style or a constant
  // fallback. If this assertion fails, the 4-identical-card bug will
  // reappear even if backend data is clean.
  const onboardingSource = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'onboarding-flow.tsx'),
    'utf8',
  );

  assert.match(
    onboardingSource,
    /props\.fontFamilies\.map\(\(font\) =>[\s\S]*?style=\{\{\s*fontFamily:\s*`[^`]*\$\{font\}[^`]*`\s*\}\}/,
    'expected each Fonts card to apply a per-item fontFamily style derived from the mapped `font` binding',
  );
});
