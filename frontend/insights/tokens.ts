// ─────────────────────────────────────────────────────────────────────────────
// tokens.ts — Design tokens (mirrors shared/styles.css palette)
// ─────────────────────────────────────────────────────────────────────────────

export const C = {
  bg:       "#0a0a0e",   // page background — near-black, matches mock
  surface:  "#121217",   // card surface
  surfaceB: "#17171d",   // nested tile / inset surface
  border:   "#23232c",   // card border
  borderB:  "#2c2c37",   // nested border
  track:    "#202028",   // progress/bar track background
  t1:       "#f4f4f8",   // primary text
  t2:       "#9a9aae",   // secondary text
  t3:       "#62627a",   // muted / labels
  accent:   "#a855f7",
  accentB:  "#c084fc",
  accentDim:"#6d28d9",
  green:    "#34d399",
  red:      "#f87171",
  amber:    "#fbbf24",
  igPink:   "#e1306c",
  fbBlue:   "#1877f2",
  liBlue:   "#0a66c2",
  xText:    "#e7e9ea",
  ytRed:    "#ff0033",
  ttBlack:  "#f4f4f8",
} as const;

export const platformColor: Record<string, string> = {
  instagram: C.igPink,
  facebook:  C.fbBlue,
  linkedin:  C.liBlue,
  x:         C.xText,
  youtube:   C.ytRed,
  tiktok:    C.t1,
  all:       C.accent,
};

export const platformLabel: Record<string, string> = {
  instagram: "Instagram",
  facebook:  "Facebook",
  linkedin:  "LinkedIn",
  x:         "X",
  youtube:   "YouTube",
  tiktok:    "TikTok",
  all:       "All channels",
};
