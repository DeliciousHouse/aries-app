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
// F1 (review, AA-229): this link MUST ALWAYS RENDER. It is the ONLY reference
// to /dashboard/analytics outside that page and the docs — no other link, no
// redirect, no CTA — so an early-return-null here is the whole reachability
// contract for the drill-down, not a cosmetic default. Two states break that
// contract if the link itself is hidden: (1) /insights' `platform` state
// starts at "all" (InsightsDashboard.tsx), so a naive "only render when
// drillable" guard hides the link on literally every first load; (2) with
// COMPOSIO_ENABLED=false — the docker-compose/CI/local default and the
// documented Composio kill switch — app/insights/page.tsx's enabledPlatforms
// (gated by isPlatformInsightsEnabled) is empty, so InsightsFilters can only
// ever show the "all" chip and `platform` can never leave "all" — the link
// would be PERMANENTLY unreachable in that (supported) configuration, while
// /dashboard/analytics itself keeps serving real historical Facebook data.
// Making a route unreachable is retiring it by accident.
//
// So: always render the link; omit the `platform` query param (not the whole
// link) when the live platform isn't one the child screen can select. The
// child's resolveInitialPlatform (analytics-screen.tsx) already falls back to
// enabledPlatforms[0] and renders its own PlatformSelector once more than one
// platform is enabled, so an omitted param still lands on a working,
// self-navigable screen. Mirrors ExportMenu.tsx, which solves the identical
// period/platform-on-"all" problem the same way on this same control row.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";

import type { Period, Platform } from "@/frontend/insights/types";
import { C, platformLabel } from "@/frontend/insights/tokens";

// Mirrors the mapping ExportMenu.tsx / ActivitySection.tsx already use for the
// same period vocabulary — the read-api `days` param clamps to 1..90 anyway.
const PERIOD_DAYS: Record<Period, number> = { week: 7, "30day": 30, "90day": 90 };

// AA-229 F2: platforms app/dashboard/analytics/page.tsx's enabledPlatforms
// can include (Facebook unconditionally, plus x/youtube/reddit/linkedin each
// behind its own rollout flag there — Instagram is deliberately absent from
// BOTH that list and this one; see analytics-screen.tsx's AA-229 follow-up
// note). Not derived from a shared import: that page resolves its list
// server-side from the four is<Platform>Enabled() flags, while this is a
// client component reading /insights' differently-gated platform chips
// (isPlatformInsightsEnabled, itself gated on COMPOSIO_ENABLED) — the two
// flag families are unrelated, so there is no single source to import from.
// It is SAFE in the direction that matters today (this set is a superset of
// anything /insights can ever hand it), but it gets no compile-time
// exhaustiveness check: if a Platform union member is added, or Instagram is
// ever added to the child screen, this Set silently stays stale. If you
// change app/dashboard/analytics/page.tsx's enabledPlatforms, update this Set.
const DRILLDOWN_PLATFORMS = new Set<Platform>(["facebook", "x", "youtube", "reddit", "linkedin"]);

export function AnalyticsDrilldownLink({ period, platform }: { period: Period; platform: Platform }) {
  const drillable = DRILLDOWN_PLATFORMS.has(platform);

  // Always carry `days`; only carry `platform` when it's one the child can
  // select — an omitted platform param is a deliberate "let the child pick
  // its own default" signal, never a silent stand-in for the real one.
  const params = new URLSearchParams({ days: String(PERIOD_DAYS[period] ?? 30) });
  if (drillable) params.set("platform", platform);

  const label = drillable ? `${platformLabel[platform] ?? platform} analytics` : "Per-platform analytics";

  return (
    <Link
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
      {label} →
    </Link>
  );
}

export default AnalyticsDrilldownLink;
