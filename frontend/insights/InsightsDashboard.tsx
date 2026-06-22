"use client";

import { useState } from "react";
import "@/frontend/insights/insights.css";
import { C } from "@/frontend/insights/tokens";
import type { Period, Platform } from "@/frontend/insights/types";

import { InsightsFilters }      from "@/frontend/insights/InsightsFilters";
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
export function InsightsDashboard() {
  const [period, setPeriod]     = useState<Period>("90day");
  const [platform, setPlatform] = useState<Platform>("all");

  return (
    <div style={{ background: C.bg, minHeight: "100%" }}>
      <div
        style={{
          padding:  "28px 40px 72px",
          maxWidth: 1280,
          width:    "100%",
          margin:   "0 auto",
        }}
      >
        {/* Every section is its own full-width row, stacked top to bottom. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 30 }}>
          {/* 1 — Hero band */}
          <HeroSection period={period} platform={platform} />

          {/* Filters sit directly UNDER the hero (matches the mock) */}
          <InsightsFilters
            period={period}
            platform={platform}
            onPeriodChange={setPeriod}
            onPlatformChange={setPlatform}
          />

          {/* 2 — Goal */}
          <GoalSection period={period} platform={platform} />
          {/* 3 — Worth your attention */}
          <AttentionSection period={period} platform={platform} />
          {/* 4 — What Aries did */}
          <ActivitySection period={period} platform={platform} />
          {/* 5 — Performance trends */}
          <TrendsSection period={period} platform={platform} />
          {/* 6 — Top performing content */}
          <TopPostsSection period={period} platform={platform} />
          {/* 7 — Conversations */}
          <ConversationsSection period={period} platform={platform} />
          {/* 8 — Working with Aries */}
          <AriesSection period={period} platform={platform} />
          {/* 9 — Audience */}
          <AudienceSection period={period} platform={platform} />
        </div>
      </div>
    </div>
  );
}

export default InsightsDashboard;
