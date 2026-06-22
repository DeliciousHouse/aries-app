// ─────────────────────────────────────────────────────────────────────────────
// tokens.ts — Design tokens (mirrors shared/styles.css palette)
// ─────────────────────────────────────────────────────────────────────────────

export const C = {
  bg:       "#0e0e12",
  surface:  "#17171d",
  surfaceB: "#1e1e26",
  border:   "#2a2a35",
  borderB:  "#33333f",
  t1:       "#f4f4f8",
  t2:       "#a0a0b8",
  t3:       "#5a5a72",
  accent:   "#a855f7",
  accentB:  "#c084fc",
  green:    "#22c55e",
  red:      "#ef4444",
  amber:    "#f59e0b",
  igPink:   "#e1306c",
  fbBlue:   "#1877f2",
  ytRed:    "#ff0000",
  ttBlack:  "#010101",
} as const;

export const platformColor: Record<string, string> = {
  instagram: C.igPink,
  facebook:  C.fbBlue,
  youtube:   C.ytRed,
  tiktok:    C.t1,
  all:       C.accent,
};

export const platformLabel: Record<string, string> = {
  instagram: "Instagram",
  facebook:  "Facebook",
  youtube:   "YouTube",
  tiktok:    "TikTok",
  all:       "All channels",
};
