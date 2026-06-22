"use client";

import { useState } from "react";
import "@/frontend/insights/insights.css";
import { C } from "@/frontend/insights/tokens";
import type { Period, Platform } from "@/frontend/insights/types";

import { Sidebar }              from "@/frontend/insights/Sidebar";
import { Header }               from "@/frontend/insights/Header";
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

export default function InsightsPage() {
  const [period, setPeriod]     = useState<Period>("90day");
  const [platform, setPlatform] = useState<Platform>("all");

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg }}>
      <Sidebar activePage="insights" />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Header
          pageTitle="Insights"
          onNotifications={() => alert("No new notifications")}
          onHelp={() => alert("Help center coming soon")}
        />

        <main
          style={{
            flex:     1,
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
        </main>
      </div>
    </div>
  );
}
