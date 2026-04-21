import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import { VISUAL_BOARD_EMPTY_STATE_COPY } from '../frontend/aries-v1/onboarding-flow.copy';

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
// FOLLOW-UP: the original test grepped string literals in the .tsx source,
// which would break under any copy refactor (e.g. extracting to a constant
// or i18n table). The empty-state copy now lives in a sidecar module
// (`onboarding-flow.copy.ts`) imported by both the component and this test,
// so the assertions can verify the actual render values directly. A small
// source-side guard remains to confirm the constants are wired into the
// component (not just declared and ignored).

test('logos empty-state copy is defined and references logos/marks', () => {
  assert.ok(
    VISUAL_BOARD_EMPTY_STATE_COPY.logos.length > 0,
    'logos empty-state copy must not be empty',
  );
  assert.match(
    VISUAL_BOARD_EMPTY_STATE_COPY.logos,
    /logo|mark/i,
    'logos empty-state copy should mention logo/mark',
  );
});

test('palette empty-state copy is defined and mentions the palette', () => {
  assert.ok(
    VISUAL_BOARD_EMPTY_STATE_COPY.palette.length > 0,
    'palette empty-state copy must not be empty',
  );
  assert.match(
    VISUAL_BOARD_EMPTY_STATE_COPY.palette,
    /palette/i,
    'palette empty-state copy should mention "palette"',
  );
});

test('fonts empty-state copy is defined and mentions type/typography', () => {
  assert.ok(
    VISUAL_BOARD_EMPTY_STATE_COPY.fonts.length > 0,
    'fonts empty-state copy must not be empty',
  );
  assert.match(
    VISUAL_BOARD_EMPTY_STATE_COPY.fonts,
    /type|font|typograph/i,
    'fonts empty-state copy should mention type/font/typography',
  );
});

test('VisualBoard component actually renders the empty-state constants (not just declares them)', () => {
  // Each of the three keys must be referenced in the .tsx source — i.e. the
  // empty-state branches still exist and are wired to the constants. This
  // guards against someone deleting the empty-state branches entirely while
  // leaving the constants behind, which would silently regress ISSUE-006.
  for (const key of ['logos', 'palette', 'fonts'] as const) {
    assert.match(
      onboardingSource,
      new RegExp(`VISUAL_BOARD_EMPTY_STATE_COPY\\.${key}\\b`),
      `expected onboarding-flow.tsx to reference VISUAL_BOARD_EMPTY_STATE_COPY.${key} in the empty-state branch`,
    );
  }

  // Populated branches must still iterate the underlying arrays so visual
  // output is unchanged when there is content to render. NOTE: ISSUE-009
  // separately tracks duplicate font cards; this test does not assert dedup
  // behaviour.
  assert.match(
    onboardingSource,
    /props\.colors\.map\(/,
    'expected the populated Palette branch to keep mapping over props.colors',
  );
  assert.match(
    onboardingSource,
    /props\.fontFamilies\.map\(/,
    'expected the populated Fonts branch to keep mapping over props.fontFamilies',
  );
});
