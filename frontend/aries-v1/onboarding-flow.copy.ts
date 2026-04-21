// ISSUE-006 follow-up: empty-state copy for the VisualBoard sub-sections,
// extracted to a sidecar module so regression tests can import the strings
// directly instead of grepping the .tsx source. The .tsx file imports from
// here so the constants are guaranteed to be the live render values.
//
// A sidecar (rather than re-exporting from onboarding-flow.tsx itself) keeps
// the test runtime free of React / Next client-component import-time deps.
export const VISUAL_BOARD_EMPTY_STATE_COPY = {
  logos: 'Logo and mark references will appear here when the site exposes them clearly.',
  palette: 'Palette cues will appear here once the website review is ready.',
  fonts: 'Type direction will appear here once the website review is ready.',
} as const;

export type VisualBoardEmptyStateKey = keyof typeof VISUAL_BOARD_EMPTY_STATE_COPY;
