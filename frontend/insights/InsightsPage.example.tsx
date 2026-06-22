// ─────────────────────────────────────────────────────────────────────────────
// InsightsPage.example.tsx
// Shows how to compose all the separate components into a full page.
// This is NOT shipped as a component — it's a reference for integration.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import "./insights.css";
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
  const [period, setPeriod]     = useState<Period>("week");
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
            flex:      1,
            padding:   "28px 28px 60px",
            maxWidth:  1100,
            width:     "100%",
            margin:    "0 auto",
          }}
        >
          {/* Filters — controls period + platform for every section */}
          <InsightsFilters
            period={period}
            platform={platform}
            onPeriodChange={setPeriod}
            onPlatformChange={setPlatform}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Row 1: Hero (full width) */}
            <HeroSection period={period} platform={platform} />

            {/* Row 2: Goal + Attention side by side */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <GoalSection      period={period} platform={platform} />
              <AttentionSection period={period} platform={platform} />
            </div>

            {/* Row 3: Activity + Trends side by side */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <ActivitySection period={period} platform={platform} />
              <TrendsSection   period={period} platform={platform} />
            </div>

            {/* Row 4: Top Posts (full width) */}
            <TopPostsSection period={period} platform={platform} />

            {/* Row 5: Conversations + Aries side by side */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <ConversationsSection period={period} platform={platform} />
              <AriesSection         period={period} platform={platform} />
            </div>

            {/* Row 6: Audience (full width) */}
            <AudienceSection period={period} platform={platform} />
          </div>
        </main>
      </div>
    </div>
  );
}
