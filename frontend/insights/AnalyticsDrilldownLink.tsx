"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AnalyticsDrilldownLink.tsx — AA-229 PR1
//
// The single entry point from /insights (the primary analytics surface) into
// the narrowed /dashboard/analytics per-platform drill-down. Before this, the
// drill-down was unreachable from /insights at all — removing its top-level
// nav entry without this link would have made the page unreachable, not
// demoted.
//
// Carries the parent's LIVE period + platform as query params so the child
// screen inherits the same window instead of silently defaulting to its own
// (30 days / Facebook) — see frontend/aries-v1/analytics-screen.tsx, which
// reads these back out.
//
// Only rendered for a single selected channel the analytics screen can
// actually render: "all" has no single platform to drill into, and Instagram
// is deliberately absent from app/dashboard/analytics/page.tsx's
// enabledPlatforms (hooks/use-insights-analytics.ts documents why) — linking
// to either would be a dead end.
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform } from "@/frontend/insights/types";
import { C, platformLabel } from "@/frontend/insights/tokens";

// Mirrors the mapping ExportMenu.tsx / ActivitySection.tsx already use for the
// same period vocabulary — the read-api `days` param clamps to 1..90 anyway.
const PERIOD_DAYS: Record<Period, number> = { week: 7, "30day": 30, "90day": 90 };

/** Platforms app/dashboard/analytics/page.tsx's enabledPlatforms can include. */
const DRILLDOWN_PLATFORMS = new Set<Platform>(["facebook", "x", "youtube", "reddit", "linkedin"]);

export function AnalyticsDrilldownLink({ period, platform }: { period: Period; platform: Platform }) {
  if (!DRILLDOWN_PLATFORMS.has(platform)) return null;

  const params = new URLSearchParams({ platform, days: String(PERIOD_DAYS[period] ?? 30) });
  const label = platformLabel[platform] ?? platform;

  return (
    <a
      href={`/dashboard/analytics?${params.toString()}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        background: "none",
        color: C.t3,
        fontSize: 12,
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label} analytics →
    </a>
  );
}

export default AnalyticsDrilldownLink;
