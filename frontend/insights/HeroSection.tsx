// ─────────────────────────────────────────────────────────────────────────────
// HeroSection.tsx
// Section 1 — Full-width hero band: storytelling narrative + Aries Score dial.
// API: GET /api/insights/narrative?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform, NarrativeData } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C, platformLabel } from "@/frontend/insights/tokens";
import { Skeleton, ErrorState, EmptyState, ScoreDial, highlightNarrative } from "@/frontend/insights/ui";

interface HeroSectionProps {
  period:   Period;
  platform: Platform;
}

const PERIOD_EYEBROW: Record<Period, string> = {
  week:    "THIS WEEK",
  "30day": "LAST 30 DAYS",
  "90day": "LAST 90 DAYS",
};

const PERIOD_WORD: Record<Period, string> = {
  week:    "week",
  "30day": "30 days",
  "90day": "90 days",
};

export function HeroSection({ period, platform }: HeroSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<NarrativeData>("narrative", period, platform);

  const pm = data?.periodMeta;
  const postsWord = pm ? (pm.posts === 1 ? pm.postsLabel : `${pm.postsLabel}s`) : "posts";

  return (
    <section
      style={{
        position:     "relative",
        background:   `radial-gradient(120% 140% at 88% 0%, #2a1148 0%, #16101f 38%, ${C.surface} 72%)`,
        border:       `1px solid ${C.border}`,
        borderRadius: 20,
        padding:      "30px 36px",
        overflow:     "hidden",
      }}
    >
      {/* Eyebrow */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
        <span
          style={{
            width: 7, height: 7, borderRadius: "50%",
            background: C.accent, boxShadow: `0 0 8px ${C.accent}`,
          }}
        />
        <span style={{ fontSize: 11, color: C.t2, fontWeight: 700, letterSpacing: "0.09em" }}>
          {PERIOD_EYEBROW[period]}
        </span>
        {data?.cached && (
          <span
            style={{
              fontSize: 10, color: C.t3, background: C.surfaceB,
              border: `1px solid ${C.border}`, borderRadius: 99, padding: "1px 7px",
            }}
          >
            cached
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Skeleton h={22} w="92%" />
          <Skeleton h={22} w="78%" />
          <Skeleton h={22} w="50%" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : data?.status === "not_connected" ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
          <EmptyState message={`Connect ${platformLabel[platform] ?? platform} to see your summary.`} />
          {data.connect_url && (
            <a
              href={data.connect_url}
              style={{
                fontSize: 13, fontWeight: 600, color: "#fff",
                background: C.accent, borderRadius: 8, padding: "8px 16px", textDecoration: "none",
              }}
            >
              Connect {platformLabel[platform] ?? platform}
            </a>
          )}
        </div>
      ) : !data?.snapshot?.hasData ? (
        <EmptyState message="Not enough data yet — publish some posts to see your summary." />
      ) : (
        <div
          style={{
            display:             "grid",
            gridTemplateColumns: "1fr auto",
            gap:                 40,
            alignItems:          "center",
          }}
        >
          {/* ── Left: storytelling narrative + comparison line ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
            <p
              style={{
                margin:     0,
                fontSize:   19,
                lineHeight: 1.62,
                fontWeight: 400,
                color:      C.t2,
                maxWidth:   620,
              }}
            >
              {highlightNarrative(data.narrative)}
            </p>

            {/* Comparison / period meta — storytelling form */}
            <div style={{ fontSize: 12.5, color: C.t3, lineHeight: 1.5 }}>
              Compared to the previous {PERIOD_WORD[period]}
              {" · "}
              <span style={{ color: C.t2 }}>{pm?.posts ?? 0}</span> {postsWord} published,{" "}
              <span style={{ color: C.t2 }}>{(pm?.comments ?? 0).toLocaleString()}</span> comments received,{" "}
              ~<span style={{ color: C.t2 }}>{Math.round(pm?.hoursSaved ?? 0)}</span> hours saved
            </div>
          </div>

          {/* ── Right: Aries Score dial ── */}
          <ScoreDial
            score={data.score}
            judgment={data.judgment}
            scoreDelta={data.scoreDelta}
          />
        </div>
      )}
    </section>
  );
}
