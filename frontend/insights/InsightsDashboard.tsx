"use client";

import { useState } from "react";
import "@/frontend/insights/insights.css";
import { C } from "@/frontend/insights/tokens";
import type { Period, Platform } from "@/frontend/insights/types";

import { InsightsFilters }      from "@/frontend/insights/InsightsFilters";
import { LazyInsightSection }   from "@/frontend/insights/LazyInsightSection";
import { FreshnessStamp }        from "@/frontend/insights/FreshnessStamp";
import { ExportMenu }            from "@/frontend/insights/ExportMenu";
import { AnalyticsDrilldownLink } from "@/frontend/insights/AnalyticsDrilldownLink";
import { HeroSection }          from "@/frontend/insights/HeroSection";
import { GoalSection }          from "@/frontend/insights/GoalSection";
import { AttentionSection }     from "@/frontend/insights/AttentionSection";
import { ActivitySection }      from "@/frontend/insights/ActivitySection";
import { TrendsSection }        from "@/frontend/insights/TrendsSection";
import { TopPostsSection }      from "@/frontend/insights/TopPostsSection";
import { ConversationsSection } from "@/frontend/insights/ConversationsSection";
import { AriesSection }         from "@/frontend/insights/AriesSection";
import { AudienceSection }      from "@/frontend/insights/AudienceSection";

/**
 * Client body for the /insights route. Renders the full insights dashboard
 * (filters + the nine stacked sections) on the redesign's dark canvas. The
 * surrounding chrome — nav, header, auth/onboarding gate, and the real
 * operator identity — is provided by the shared AppShellLayout in
 * app/insights/page.tsx, so this component owns content only.
 */
export function InsightsDashboard({
  nativeReplyEnabled = false,
  enabledPlatforms = [],
}: {
  nativeReplyEnabled?: boolean;
  /** Platforms with a live insights adapter, resolved server-side. */
  enabledPlatforms?: readonly Platform[];
} = {}) {
  const [period, setPeriod]     = useState<Period>("90day");
  const [platform, setPlatform] = useState<Platform>("all");

  return (
    <div style={{ background: C.bg, minHeight: "100%" }}>
      <div
        className="insights-dashboard-content"
        style={{
          maxWidth: 1600,
          width:    "100%",
          margin:   "0 auto",
        }}
      >
        {/* Every section is its own full-width row, stacked top to bottom. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 30 }}>
          {/* 1 — Hero band */}
          <HeroSection period={period} platform={platform} />

          {/* Filters sit directly UNDER the hero (matches the mock); the
              data-freshness stamp is right-aligned on the same control row. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <InsightsFilters
              period={period}
              platform={platform}
              onPeriodChange={setPeriod}
              onPlatformChange={setPlatform}
              enabledPlatforms={enabledPlatforms}
            />
            {/* marginLeft:auto keeps this group hard-right even when the row
                wraps. Without it, adding the export control tipped a row that
                was already near capacity (six channel chips) onto a second
                line, where space-between left-aligns it under the filters. */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
              {/* AA-229 PR1: the /dashboard/analytics per-platform drill-down,
                  carrying the same live period + platform as everything else
                  on this row. Renders nothing on "all" or Instagram (see the
                  component for why). */}
              <AnalyticsDrilldownLink period={period} platform={platform} />
              {/* S5-3: export sits on the control row so it inherits the same
                  period + platform the sections below are showing. */}
              <ExportMenu period={period} platform={platform} />
              <FreshnessStamp />
            </div>
          </div>

          {/* 2 — Goal */}
          <GoalSection period={period} platform={platform} />
          {/* 3 — Worth your attention */}
          <LazyInsightSection>
            {(visible) => <AttentionSection period={period} platform={platform} enabled={visible} />}
          </LazyInsightSection>
          {/* 4 — What Aries did */}
          <LazyInsightSection>
            {(visible) => <ActivitySection period={period} platform={platform} enabled={visible} />}
          </LazyInsightSection>
          {/* 5 — Performance trends */}
          <LazyInsightSection>
            {(visible) => <TrendsSection period={period} platform={platform} enabled={visible} />}
          </LazyInsightSection>
          {/* 6 — Top performing content */}
          <LazyInsightSection>
            {(visible) => <TopPostsSection period={period} platform={platform} enabled={visible} />}
          </LazyInsightSection>
          {/* 7 — Conversations */}
          <LazyInsightSection>
            {(visible) => <ConversationsSection period={period} platform={platform} nativeReplyEnabled={nativeReplyEnabled} enabled={visible} />}
          </LazyInsightSection>
          {/* 8 — Working with Aries */}
          <LazyInsightSection>
            {(visible) => <AriesSection period={period} platform={platform} enabled={visible} />}
          </LazyInsightSection>
          {/* 9 — Audience */}
          <LazyInsightSection>
            {(visible) => <AudienceSection period={period} platform={platform} enabled={visible} />}
          </LazyInsightSection>
        </div>
      </div>
    </div>
  );
}

export default InsightsDashboard;
