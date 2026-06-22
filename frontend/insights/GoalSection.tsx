// ─────────────────────────────────────────────────────────────────────────────
// GoalSection.tsx
// Section 2 — Primary business goal tracking
// API: GET /api/insights/goal?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform, GoalData } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import { SectionCard, DeltaBadge, PlatformDot, ErrorState, EmptyState, Skeleton } from "@/frontend/insights/ui";

interface GoalSectionProps {
  period:   Period;
  platform: Platform;
}

export function GoalSection({ period, platform }: GoalSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<GoalData>("goal", period, platform);

  return (
    <SectionCard title="Goal" eyebrow="Business goal">
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Skeleton h={16} w="40%" />
          <Skeleton h={40} w="55%" />
          <Skeleton h={16} w="70%" />
          <Skeleton h={48} />
          <Skeleton h={48} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : data?.status === "no_goal" ? (
        <EmptyState message="No primary goal set. Go to Settings to configure your goal." />
      ) : !data ? (
        <EmptyState message="No primary goal set. Go to Settings to configure your goal." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* ── Goal label ── */}
          {data.goalLabel && (
            <div
              style={{
                fontSize:      11,
                color:         C.t3,
                fontWeight:    600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {data.goalLabel}
            </div>
          )}

          {/* ── Primary metric ── */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize:           42,
                fontWeight:         800,
                color:              C.t1,
                fontVariantNumeric: "tabular-nums",
                lineHeight:         1,
              }}
            >
              {data.metricValue.toLocaleString()}
            </span>
            <span style={{ fontSize: 14, color: C.t3 }}>{data.metricLabel}</span>
            <DeltaBadge delta={data.metricDelta} />
          </div>

          {/* ── Secondary metric ── */}
          {data.secondaryValue != null && (
            <div
              style={{
                display:      "inline-flex",
                alignItems:   "baseline",
                gap:          6,
                padding:      "10px 14px",
                background:   C.surfaceB,
                border:       `1px solid ${C.borderB}`,
                borderRadius: 10,
                width:        "fit-content",
              }}
            >
              <span
                style={{
                  fontSize:           18,
                  fontWeight:         700,
                  color:              C.t1,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {data.secondaryValue.toLocaleString()}
              </span>
              <span style={{ fontSize: 13, color: C.t2 }}>{data.secondaryLabel}</span>
            </div>
          )}

          {/* ── Aries note ── */}
          {data.ariesLine && (
            <div
              style={{
                fontSize:   13,
                lineHeight: 1.5,
                color:      C.t2,
                paddingLeft: 12,
                borderLeft:  `2px solid ${C.accent}`,
              }}
            >
              <strong style={{ color: C.accentB }}>Aries:</strong> {data.ariesLine}
            </div>
          )}

          {/* ── Contributors ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                fontSize:      12,
                color:         C.t3,
                fontWeight:    600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              What contributed
            </div>

            {data.contributors.length === 0 ? (
              <span style={{ fontSize: 13, color: C.t3 }}>
                No contributing posts yet — Aries is still building signal.
              </span>
            ) : (
              data.contributors.map((c, i) => (
                <div
                  key={i}
                  style={{
                    display:        "flex",
                    alignItems:     "center",
                    justifyContent: "space-between",
                    padding:        "10px 12px",
                    background:     C.surfaceB,
                    border:         `1px solid ${C.borderB}`,
                    borderRadius:   8,
                    gap:            8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <PlatformDot platform={c.platform} />
                    <span
                      style={{
                        fontSize:     13,
                        color:        C.t2,
                        overflow:     "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace:   "nowrap",
                      }}
                    >
                      {c.title}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize:           13,
                      fontWeight:         700,
                      color:              C.t1,
                      flexShrink:         0,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {c.metricValue.toLocaleString()}{" "}
                    <span style={{ fontSize: 11, color: C.t3, fontWeight: 500 }}>
                      {c.metricLabel}
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
