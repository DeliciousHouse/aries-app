import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const onboardingSource = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'onboarding-flow.tsx'),
  'utf8',
);

// ISSUE-006 — On the Brand identity step (Step 4), the Palette and Fonts
// sub-sections rendered just a heading with nothing beneath when the brand-kit
// extractor returned zero colors / fonts. The Logo-candidates section already
// rendered explanatory copy in the same situation. The fix matches that pattern
// for Palette and Fonts so the empty state never reads as a broken UI.
//
// These guards lock in:
//   1. The Logo-candidates empty-state copy (the reference pattern).
//   2. A Palette empty-state branch with parallel placeholder copy.
//   3. A Fonts empty-state branch with parallel placeholder copy.
//   4. The populated branches still iterate the underlying arrays so visual
//      output is unchanged when there is content to show.

test('Logo candidates section keeps its empty-state copy (reference pattern)', () => {
  assert.match(
    onboardingSource,
    /logoUrls\.length\s*>\s*0\s*\?[\s\S]*?:\s*\(\s*\n\s*<p[^>]*>Logo and mark references will appear here when the site exposes them clearly\.<\/p>/,
    'expected the Logo candidates section to render its empty-state placeholder when logoUrls is empty',
  );
});

test('Palette section renders empty-state copy when colors array is empty (ISSUE-006)', () => {
  // Conditional branch: empty colors → placeholder copy.
  assert.match(
    onboardingSource,
    /props\.colors\.length\s*>\s*0\s*\?[\s\S]*?:\s*\(\s*\n\s*<p[^>]*>[^<]*will appear here[^<]*<\/p>/,
    'expected the Palette section to fall back to a "will appear here" placeholder when props.colors is empty',
  );

  // The placeholder copy must mention the palette/colors so a screen reader
  // user understands which section is empty.
  assert.match(
    onboardingSource,
    /<p[^>]*>Palette[^<]*will appear here[^<]*<\/p>/i,
    'expected the Palette empty-state copy to mention "Palette" and "will appear here"',
  );

  // Populated branch must still iterate colors so visual output is unchanged
  // when there is content to render.
  assert.match(
    onboardingSource,
    /props\.colors\.map\(\(color, index\) =>/,
    'expected the populated Palette branch to keep mapping over props.colors',
  );
});

test('Fonts section renders empty-state copy when fontFamilies array is empty (ISSUE-006)', () => {
  // Conditional branch: empty fontFamilies → placeholder copy.
  assert.match(
    onboardingSource,
    /props\.fontFamilies\.length\s*>\s*0\s*\?[\s\S]*?:\s*\(\s*\n\s*<p[^>]*>[^<]*will appear here[^<]*<\/p>/,
    'expected the Fonts section to fall back to a "will appear here" placeholder when props.fontFamilies is empty',
  );

  // The placeholder copy must convey type/font direction so users know which
  // section is awaiting data.
  assert.match(
    onboardingSource,
    /<p[^>]*>(Type direction|Fonts?|Typography)[^<]*will appear here[^<]*<\/p>/i,
    'expected the Fonts empty-state copy to reference type/typography and "will appear here"',
  );

  // Populated branch must still iterate fontFamilies so visual output is
  // unchanged when there is content to render. NOTE: ISSUE-009 separately
  // tracks duplicate font cards; this test does not assert dedup behaviour.
  assert.match(
    onboardingSource,
    /props\.fontFamilies\.map\(\(font\) =>/,
    'expected the populated Fonts branch to keep mapping over props.fontFamilies',
  );
});
