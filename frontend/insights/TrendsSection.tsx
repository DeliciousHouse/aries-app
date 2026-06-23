// ─────────────────────────────────────────────────────────────────────────────
// TrendsSection.tsx
// Performance — metric tabs + current-vs-prior chart + key movements,
// with a separate "Where … came from" panel below.
// API: GET /api/insights/trends?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import type {
  Period, Platform, TrendsData, TrendMetricKey, KeyMovement,
} from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C, platformColor, platformLabel } from "@/frontend/insights/tokens";
import {
  SectionHeader, Panel, DeltaBadge, Icon, ChannelIcon, ErrorState, EmptyState, LoadingRows,
} from "@/frontend/insights/ui";
import {
  LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
} from "recharts";

interface TrendsSectionProps {
  period:   Period;
  platform: Platform;
}

const METRIC_ORDER: TrendMetricKey[] = ["reach", "engagement", "followers", "comments", "visits"];

function movementColor(direction: KeyMovement["direction"]): string {
  switch (direction) {
    case "up":   return C.green;
    case "down": return C.red;
    case "flag": return C.amber;
    case "flat":
    default:     return C.t3;
  }
}

function MovementIcon({ direction }: { direction: KeyMovement["direction"] }) {
  const color = movementColor(direction);
  if (direction === "down")
    return <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}><Icon name="arrow-up" size={13} color={color} /></span>;
  if (direction === "flag") return <Icon name="bell" size={13} color={color} />;
  if (direction === "flat") return <Icon name="trend" size={13} color={color} />;
  return <Icon name="arrow-up" size={13} color={color} />;
}

// Small line swatch for the chart legend (solid = this period, dashed = prior).
function LineSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-block", width: 18, height: 0, borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}`, marginRight: 6, verticalAlign: "middle" }} />
  );
}

export function TrendsSection({ period, platform }: TrendsSectionProps) {
  const { data, loading, error, refetch } = useInsight<TrendsData>("trends", period, platform);
  const [selected, setSelected] = useState<TrendMetricKey>("reach");

  if (loading || error || !data?.meta?.hasData) {
    return (
      <section>
        <SectionHeader title="Performance trends" />
        <Panel>
          {loading ? <LoadingRows n={4} />
            : error ? <ErrorState message={error} onRetry={refetch} />
            : <EmptyState message="No trend data for this period." />}
        </Panel>
      </section>
    );
  }

  const presentKeys = METRIC_ORDER.filter((k) => data.metrics[k]);
  const activeKey: TrendMetricKey = data.metrics[selected] ? selected : presentKeys[0] ?? "reach";
  const metric = data.metrics[activeKey] ?? null;
  const series = data.series[activeKey] ?? null;
  const breakdown = data.platformBreakdown[activeKey] ?? null;
  const metricWord = metric?.label.toLowerCase() ?? "reach";

  const chartRows = series
    ? series.labels.map((name, i) => ({ name, current: series.current[i] ?? null, prior: series.prior[i] ?? null }))
    : [];

  return (
    <section>
      <SectionHeader title="Performance trends" />

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* ── Main panel: tabs + headline + chart + key movements ── */}
        <Panel>
          <style>{`
            .trends-supporting .pos { color: ${C.green}; }
            .trends-supporting .neg { color: ${C.red}; }
            .trends-supporting .strong { color: ${C.t1}; font-weight: 600; }
          `}</style>

          {/* Metric tabs */}
          <div style={{ display: "flex", gap: 24, borderBottom: `1px solid ${C.border}`, marginBottom: 18 }}>
            {presentKeys.map((key) => {
              const m = data.metrics[key];
              if (!m) return null;
              const isActive = key === activeKey;
              return (
                <button
                  key={key}
                  onClick={() => setSelected(key)}
                  style={{
                    background: "none", border: "none",
                    borderBottom: `2px solid ${isActive ? C.accent : "transparent"}`,
                    cursor: "pointer", padding: "0 0 10px", marginBottom: -1,
                    fontSize: 13, fontWeight: isActive ? 600 : 500,
                    color: isActive ? C.t1 : C.t3,
                    display: "inline-flex", alignItems: "center", gap: 6,
                  }}
                >
                  <Icon name={m.icon} size={13} color={isActive ? C.accentB : C.t3} />
                  {m.label}
                </button>
              );
            })}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 28 }}>
            {/* LEFT: headline + chart + Aries interpretation (below chart) */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {metric && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 32, fontWeight: 800, color: C.t1, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                      {metric.headline}
                    </span>
                    {metric.headlineSuffix && <span style={{ fontSize: 14, color: C.t3 }}>{metric.headlineSuffix}</span>}
                    {metric.delta !== null && <DeltaBadge delta={metric.delta} />}
                  </div>
                  {metric.supporting && (
                    <div className="trends-supporting" style={{ fontSize: 13, color: C.t2, lineHeight: 1.55 }}
                      dangerouslySetInnerHTML={{ __html: metric.supporting }} />
                  )}
                </div>
              )}

              {series && chartRows.length > 0 && (
                <div>
                  <ResponsiveContainer width="100%" height={210}>
                    <LineChart data={chartRows}>
                      <CartesianGrid stroke={C.border} strokeDasharray="4 4" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10, fill: C.t3 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: C.t3 }} axisLine={false} tickLine={false} width={40} />
                      <Tooltip
                        contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.t1 }}
                        labelStyle={{ color: C.t3 }}
                      />
                      <Line type="monotone" dataKey="prior" name="Previous period" stroke={C.t3} strokeWidth={1.5} strokeDasharray="5 4" dot={false} connectNulls />
                      <Line type="monotone" dataKey="current" name="This period" stroke={C.accent} strokeWidth={2} dot={false} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                  <div style={{ display: "flex", gap: 20, marginTop: 8, fontSize: 11, alignItems: "center" }}>
                    <span style={{ color: C.t2 }}><LineSwatch color={C.accent} />This period</span>
                    <span style={{ color: C.t2 }}><LineSwatch color={C.t3} dashed />Previous period</span>
                  </div>
                </div>
              )}

              {/* Aries interpretation — BELOW the chart (after the user has read the numbers + line) */}
              {metric?.interpretation && (
                <div style={{ display: "flex", gap: 9, fontSize: 12.5, lineHeight: 1.5, padding: "11px 13px", background: `${C.accent}10`, border: `1px solid ${C.accent}28`, borderRadius: 10 }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="info" size={14} color={C.accentB} /></span>
                  <span style={{ color: C.t2 }}><strong style={{ color: C.accentB }}>Aries:</strong> {metric.interpretation}</span>
                </div>
              )}
            </div>

            {/* RIGHT: key movements */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4, borderLeft: `1px solid ${C.border}`, paddingLeft: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Icon name="trend" size={14} color={C.accentB} />
                <span style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>Key movements</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.t3, marginBottom: 8 }}>What changed across all your metrics</div>

              {data.keyMovements.length === 0 ? (
                <div style={{ fontSize: 12.5, color: C.t3, paddingTop: 6 }}>Nothing notable moved this period.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {data.keyMovements.map((mv, i) => {
                    const color = movementColor(mv.direction);
                    return (
                      <div key={`${mv.label}-${i}`} style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 0", borderTop: i === 0 ? "none" : `1px solid ${C.border}` }}>
                        <span style={{ flexShrink: 0, width: 28, height: 28, borderRadius: "50%", background: `${color}1c`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                          <MovementIcon direction={mv.direction} />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 13, color: C.t1 }}>{mv.label}</span>
                            <span style={{ fontSize: 13, fontWeight: 700, color, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{mv.value}</span>
                          </div>
                          {mv.note && <span style={{ fontSize: 11, color: C.t3 }}>{mv.note}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </Panel>

        {/* ── Separate panel: where the metric comes from ── */}
        {breakdown && breakdown.length > 0 && (
          <Panel>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
              Where {metricWord} came from
            </div>
            <div style={{ fontSize: 11.5, color: C.t3, marginTop: 3, marginBottom: 16 }}>
              Distribution across your active channels
            </div>
            <div style={{ display: "flex", gap: 2, height: 14, borderRadius: 99, overflow: "hidden", background: C.track }}>
              {breakdown.map((slice) => (
                <div
                  key={slice.platform}
                  title={`${platformLabel[slice.platform] ?? slice.platform} ${slice.pct}%`}
                  style={{
                    width: `${slice.pct}%`, background: platformColor[slice.platform] ?? C.t3,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9.5, fontWeight: 700, letterSpacing: "0.02em",
                    color: "#fff", whiteSpace: "nowrap", overflow: "hidden",
                  }}
                >
                  {slice.pct >= 18 ? `${slice.pct}%` : ""}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 12 }}>
              {breakdown.map((slice) => (
                <div key={slice.platform} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <ChannelIcon platform={slice.platform} size={13} />
                  <span style={{ fontSize: 12, color: C.t2 }}>{platformLabel[slice.platform] ?? slice.platform}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: C.t1, fontVariantNumeric: "tabular-nums" }}>{slice.pct}%</span>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </section>
  );
}
