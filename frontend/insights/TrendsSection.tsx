// ─────────────────────────────────────────────────────────────────────────────
// TrendsSection.tsx
// Performance — selectable metric tabs + current-vs-prior chart + key movements
// API: GET /api/insights/trends?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import type {
  Period,
  Platform,
  TrendsData,
  TrendMetricKey,
  KeyMovement,
} from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import {
  SectionCard,
  DeltaBadge,
  ErrorState,
  EmptyState,
  Skeleton,
} from "@/frontend/insights/ui";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

interface TrendsSectionProps {
  period:   Period;
  platform: Platform;
}

const METRIC_ORDER: TrendMetricKey[] = [
  "reach",
  "engagement",
  "followers",
  "comments",
  "visits",
];

function movementGlyph(direction: KeyMovement["direction"]): { symbol: string; color: string } {
  switch (direction) {
    case "up":   return { symbol: "▲", color: C.green };
    case "down": return { symbol: "▼", color: C.red };
    case "flag": return { symbol: "⚑", color: C.amber };
    case "flat":
    default:     return { symbol: "●", color: C.t3 };
  }
}

export function TrendsSection({ period, platform }: TrendsSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<TrendsData>("trends", period, platform);

  const [selected, setSelected] = useState<TrendMetricKey>("reach");

  // Resolve the metric to actually render: prefer the selected one if present,
  // else fall back to the first available so we never show a blank panel.
  const presentKeys = data
    ? METRIC_ORDER.filter((k) => data.metrics[k])
    : [];
  const activeKey: TrendMetricKey =
    data && data.metrics[selected]
      ? selected
      : presentKeys[0] ?? "reach";

  const activeMetric = data?.metrics[activeKey] ?? null;
  const series       = data?.series[activeKey] ?? null;

  const chartRows =
    series
      ? series.labels.map((name, i) => ({
          name,
          current: series.current[i] ?? null,
          prior:   series.prior[i] ?? null,
        }))
      : [];

  return (
    <SectionCard title="Trends" eyebrow="Performance">
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {[1, 2, 3].map((n) => <Skeleton key={n} h={72} />)}
          </div>
          <Skeleton h={140} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : !data?.meta?.hasData ? (
        <EmptyState message="No trend data for this period." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Metric-tab strip */}
          <div
            style={{
              display:             "grid",
              gridTemplateColumns: `repeat(${Math.max(presentKeys.length, 1)}, 1fr)`,
              gap:                 10,
            }}
          >
            {presentKeys.map((key) => {
              const m = data.metrics[key];
              if (!m) return null;
              const isActive = key === activeKey;
              return (
                <button
                  key={key}
                  onClick={() => setSelected(key)}
                  style={{
                    textAlign:     "left",
                    cursor:        "pointer",
                    background:    isActive ? `${C.accent}14` : C.surfaceB,
                    border:        `1px solid ${isActive ? `${C.accent}55` : C.borderB}`,
                    borderRadius:  12,
                    padding:       "12px 14px",
                    display:       "flex",
                    flexDirection: "column",
                    gap:           6,
                  }}
                >
                  <span style={{ fontSize: 11, color: C.t3, fontWeight: 500 }}>
                    {m.icon ? `${m.icon} ` : ""}{m.label}
                  </span>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
                    <span
                      style={{
                        fontSize:           20,
                        fontWeight:         700,
                        color:              C.t1,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {m.headline}
                    </span>
                    {m.headlineSuffix && (
                      <span style={{ fontSize: 11, color: C.t3 }}>{m.headlineSuffix}</span>
                    )}
                  </span>
                  {m.delta !== null && <DeltaBadge delta={m.delta} />}
                </button>
              );
            })}
          </div>

          {/* Selected metric narrative */}
          {activeMetric && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{ fontSize: 13, color: C.t2, lineHeight: 1.55 }}
                dangerouslySetInnerHTML={{ __html: activeMetric.supporting }}
              />
              {activeMetric.interpretation && (
                <div
                  style={{
                    fontSize:     12,
                    color:        C.accentB,
                    lineHeight:   1.5,
                    padding:      "10px 12px",
                    background:   `${C.accent}10`,
                    border:       `1px solid ${C.accent}28`,
                    borderRadius: 10,
                  }}
                >
                  <strong style={{ color: C.accentB }}>Aries:</strong>{" "}
                  <span style={{ color: C.t2 }}>{activeMetric.interpretation}</span>
                </div>
              )}
            </div>
          )}

          {/* Current vs prior chart */}
          {series && chartRows.length > 0 && (
            <div
              style={{
                background:   C.surfaceB,
                border:       `1px solid ${C.borderB}`,
                borderRadius: 10,
                padding:      "16px 16px 10px",
              }}
            >
              <div
                style={{
                  fontSize:     11,
                  color:        C.t3,
                  fontWeight:   500,
                  marginBottom: 12,
                }}
              >
                Current vs prior period
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={chartRows}>
                  <CartesianGrid stroke={C.border} strokeDasharray="4 4" vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 10, fill: C.t3 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: C.t3 }}
                    axisLine={false}
                    tickLine={false}
                    width={36}
                  />
                  <Tooltip
                    contentStyle={{
                      background:   C.surface,
                      border:       `1px solid ${C.border}`,
                      borderRadius: 8,
                      fontSize:     12,
                      color:        C.t1,
                    }}
                    labelStyle={{ color: C.t3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="current"
                    name="Current"
                    stroke={C.accent}
                    strokeWidth={2}
                    dot={{ r: 3, fill: C.accent, strokeWidth: 0 }}
                    activeDot={{ r: 5, strokeWidth: 0 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="prior"
                    name="Prior"
                    stroke={C.t3}
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Key movements */}
          {data.keyMovements.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div
                style={{
                  fontSize:      11,
                  fontWeight:    600,
                  color:         C.t3,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Key movements
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {data.keyMovements.map((mv, i) => {
                  const g = movementGlyph(mv.direction);
                  return (
                    <div
                      key={`${mv.label}-${i}`}
                      style={{ display: "flex", alignItems: "baseline", gap: 10 }}
                    >
                      <span style={{ color: g.color, fontSize: 13, flexShrink: 0 }}>
                        {g.symbol}
                      </span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                          <span style={{ fontSize: 13, color: C.t1, fontWeight: 600 }}>
                            {mv.label}
                          </span>
                          <span
                            style={{
                              fontSize:           13,
                              color:              g.color,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {mv.value}
                          </span>
                        </div>
                        {mv.note && (
                          <span style={{ fontSize: 12, color: C.t3 }}>{mv.note}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
