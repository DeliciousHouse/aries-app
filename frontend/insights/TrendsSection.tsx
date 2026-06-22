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
import { C, platformColor, platformLabel } from "@/frontend/insights/tokens";
import {
  SectionHeader,
  Panel,
  DeltaBadge,
  Icon,
  ChannelIcon,
  ErrorState,
  EmptyState,
  LoadingRows,
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

function movementColor(direction: KeyMovement["direction"]): string {
  switch (direction) {
    case "up":   return C.green;
    case "down": return C.red;
    case "flag": return C.amber;
    case "flat":
    default:     return C.t3;
  }
}

// Icon + (optional) rotation per key-movement direction.
function MovementIcon({ direction }: { direction: KeyMovement["direction"] }) {
  const color = movementColor(direction);
  if (direction === "up")   return <Icon name="arrow-up" size={15} color={color} />;
  if (direction === "down")
    return (
      <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
        <Icon name="arrow-up" size={15} color={color} />
      </span>
    );
  if (direction === "flag") return <Icon name="bell" size={15} color={color} />;
  return <Icon name="trend" size={15} color={color} />;
}

export function TrendsSection({ period, platform }: TrendsSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<TrendsData>("trends", period, platform);

  const [selected, setSelected] = useState<TrendMetricKey>("reach");

  return (
    <section>
      <SectionHeader title="Performance trends" />
      <Panel>
        {loading ? (
          <LoadingRows n={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : !data?.meta?.hasData ? (
          <EmptyState message="No trend data for this period." />
        ) : (
          <TrendsBody data={data} selected={selected} setSelected={setSelected} />
        )}
      </Panel>
    </section>
  );
}

function TrendsBody({
  data,
  selected,
  setSelected,
}: {
  data:        TrendsData;
  selected:    TrendMetricKey;
  setSelected: (k: TrendMetricKey) => void;
}) {
  const presentKeys = METRIC_ORDER.filter((k) => data.metrics[k]);

  // Resolve active key: prefer selected if present, else first present key.
  const activeKey: TrendMetricKey =
    data.metrics[selected] ? selected : presentKeys[0] ?? "reach";

  const metric = data.metrics[activeKey] ?? null;
  const series = data.series[activeKey] ?? null;
  const breakdown = data.platformBreakdown[activeKey] ?? null;

  const chartRows = series
    ? series.labels.map((name, i) => ({
        name,
        current: series.current[i] ?? null,
        prior:   series.prior[i] ?? null,
      }))
    : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* scoped narrative span styling */}
      <style>{`
        .trends-supporting .pos { color: ${C.green}; }
        .trends-supporting .neg { color: ${C.red}; }
        .trends-supporting .strong { color: ${C.t1}; font-weight: 600; }
      `}</style>

      {/* ── Metric-tab strip (full width) ──────────────────────────────────── */}
      <div
        style={{
          display:      "flex",
          gap:          24,
          borderBottom: `1px solid ${C.border}`,
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
                background:    "none",
                border:        "none",
                borderBottom:  `2px solid ${isActive ? C.accent : "transparent"}`,
                cursor:        "pointer",
                padding:       "0 0 10px",
                marginBottom:  -1,
                fontSize:      13,
                fontWeight:    isActive ? 600 : 500,
                color:         isActive ? C.t1 : C.t3,
                display:       "inline-flex",
                alignItems:    "center",
                gap:           6,
              }}
            >
              <Icon name={m.icon} size={13} color={isActive ? C.accentB : C.t3} />
              {m.label}
            </button>
          );
        })}
      </div>

      {/* ── Headline + delta (full width) ──────────────────────────────────── */}
      {metric && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize:           32,
                fontWeight:         800,
                color:              C.t1,
                lineHeight:         1,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {metric.headline}
            </span>
            {metric.headlineSuffix && (
              <span style={{ fontSize: 14, color: C.t3 }}>{metric.headlineSuffix}</span>
            )}
            {metric.delta !== null && <DeltaBadge delta={metric.delta} />}
          </div>

          {metric.supporting && (
            <div
              className="trends-supporting"
              style={{ fontSize: 13, color: C.t2, lineHeight: 1.55 }}
              dangerouslySetInnerHTML={{ __html: metric.supporting }}
            />
          )}

          {metric.interpretation && (
            <div
              style={{
                fontSize:     12,
                lineHeight:   1.5,
                padding:      "10px 12px",
                background:   `${C.accent}10`,
                border:       `1px solid ${C.accent}28`,
                borderRadius: 10,
              }}
            >
              <strong style={{ color: C.accentB }}>Aries:</strong>{" "}
              <span style={{ color: C.t2 }}>{metric.interpretation}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Chart + key movements (2-col) ──────────────────────────────────── */}
      <div
        style={{
          display:             "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap:                 24,
        }}
      >
        {/* LEFT: chart + breakdown */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {series && chartRows.length > 0 && (
            <div>
              <ResponsiveContainer width="100%" height={200}>
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
                    width={40}
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
                  {/* prior (dashed) drawn first so the solid current line reads on top */}
                  <Line
                    type="monotone"
                    dataKey="prior"
                    name="Previous period"
                    stroke={C.t3}
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="current"
                    name="This period"
                    stroke={C.accent}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>

              {/* chart legend */}
              <div style={{ display: "flex", gap: 18, marginTop: 6, fontSize: 11 }}>
                <span style={{ color: C.accent }}>● This period</span>
                <span style={{ color: C.t3 }}>╌ Previous period</span>
              </div>
            </div>
          )}

          {/* Where reach comes from */}
          {breakdown && breakdown.length > 0 && (
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
                Where {metric?.label.toLowerCase() ?? "reach"} comes from
              </div>

              <div
                style={{
                  display:      "flex",
                  height:       10,
                  borderRadius: 99,
                  overflow:     "hidden",
                  background:   C.track,
                }}
              >
                {breakdown.map((slice) => (
                  <div
                    key={slice.platform}
                    style={{
                      width:      `${slice.pct}%`,
                      background: platformColor[slice.platform] ?? C.t3,
                    }}
                  />
                ))}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                {breakdown.map((slice) => (
                  <div
                    key={slice.platform}
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <ChannelIcon platform={slice.platform} size={13} />
                    <span style={{ fontSize: 12, color: C.t2 }}>
                      {platformLabel[slice.platform] ?? slice.platform}
                    </span>
                    <span
                      style={{
                        fontSize:           12,
                        color:              C.t3,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {slice.pct}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: key movements */}
        {data.keyMovements.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
            <div style={{ display: "flex", flexDirection: "column" }}>
              {data.keyMovements.map((mv, i) => {
                const color = movementColor(mv.direction);
                return (
                  <div
                    key={`${mv.label}-${i}`}
                    style={{
                      display:       "flex",
                      alignItems:    "flex-start",
                      gap:           10,
                      padding:       "11px 0",
                      borderTop:     i === 0 ? "none" : `1px solid ${C.border}`,
                    }}
                  >
                    <span style={{ flexShrink: 0, marginTop: 1 }}>
                      <MovementIcon direction={mv.direction} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display:        "flex",
                          gap:            8,
                          alignItems:     "baseline",
                          justifyContent: "space-between",
                        }}
                      >
                        <span style={{ fontSize: 13, color: C.t1 }}>{mv.label}</span>
                        <span
                          style={{
                            fontSize:           13,
                            fontWeight:         700,
                            color,
                            flexShrink:         0,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {mv.value}
                        </span>
                      </div>
                      {mv.note && (
                        <span style={{ fontSize: 11, color: C.t3 }}>{mv.note}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
