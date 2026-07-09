"use client";

// ─────────────────────────────────────────────────────────────────────────────
// S1-9-PROVISIONAL-DISCLOSURE — REMOVE IN S2-1 (Gap A1 fix).
//
// INTERIM disclosure component. Per-post metrics come back from Meta as
// lifetime-cumulative snapshots stamped with today's date, but every reader
// currently SUMs them across daily rows as if each day's value were that day's
// delta — so raw per-post totals over-count (~N× over N days of syncing).
//
// This is NOT the fix. S2-1 (AA-88's follow-up, Gap A1) changes every reader to
// latest-snapshot / window-delta math and DELETES this disclosure. Its own
// acceptance says "removes the S1-9 disclosure".
//
// To remove cleanly in S2-1:
//   grep -rn "S1-9-PROVISIONAL-DISCLOSURE"
//   → delete this file, its two <ProvisionalMetricNote/> usages
//     (TopPostsSection, GoalSection), and the matching inline note on the
//     legacy /dashboard/analytics screen (frontend/aries-v1/analytics-screen.tsx).
//
// Only RAW summed counts are labelled (reach, saves, shares, comments,
// avg reach, goal contributor values). Ratios (engagement %, save rate,
// multiplier), rankings, the high-performers count, and currentFollowers
// (account-level, fixed in S1-8) are NOT affected and are NOT labelled.
// ─────────────────────────────────────────────────────────────────────────────

import { C } from "@/frontend/insights/tokens";
import { Icon } from "@/frontend/insights/ui";

export function ProvisionalMetricNote({ label = "Provisional totals" }: { label?: string }) {
  return (
    <span
      title="These totals currently over-count — a metrics fix is in progress. Rankings are reliable; the absolute numbers will drop once corrected."
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontSize: 11, color: C.amber,
        background: `${C.amber}14`, border: `1px solid ${C.amber}55`,
        borderRadius: 99, padding: "3px 9px", whiteSpace: "nowrap",
      }}
    >
      <Icon name="info" size={11} color={C.amber} />
      {label} — correcting soon
    </span>
  );
}
