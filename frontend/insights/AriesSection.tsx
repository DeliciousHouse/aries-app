// ─────────────────────────────────────────────────────────────────────────────
// AriesSection.tsx
// Section 8 — Working with Aries: AI adoption + approval flow (uncached endpoint)
// API: GET /api/insights/aries?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform, AriesData } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import {
  SectionCard,
  ErrorState,
  EmptyState,
  LoadingRows,
  DeltaBadge,
  Divider,
} from "@/frontend/insights/ui";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface AriesSectionProps {
  period:   Period;
  platform: Platform;
}

function LegendItem({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: C.t2 }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.t1, fontVariantNumeric: "tabular-nums" }}>
        {count}
      </span>
    </div>
  );
}

export function AriesSection({ period, platform }: AriesSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<AriesData>("aries", period, platform);

  const empty = !data?.approvalFlow || data.approvalFlow.drafts === 0;

  const curve = data?.learningCurve;
  const chartData =
    curve && curve.labels.length > 0
      ? curve.labels.map((name, i) => ({ name, value: curve.values[i] ?? 0 }))
      : [];

  return (
    <SectionCard title="Working with Aries" eyebrow="AI adoption">
      {loading ? (
        <LoadingRows n={3} />
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : empty || !data ? (
        <EmptyState message="No Aries activity recorded this period." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Headline: first-try rate */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 30, fontWeight: 700, color: C.t1, fontVariantNumeric: "tabular-nums" }}>
              {data.approvalFlow.firstTryRate}%
            </span>
            <span style={{ fontSize: 13, color: C.t2 }}>approved first try</span>
            <DeltaBadge
              delta={data.approvalFlow.firstTryRate - data.approvalFlow.firstTryRatePriorPeriod}
            />
          </div>

          {/* Stacked horizontal bar: firstTry / edited / rebuilt */}
          {(() => {
            const { drafts, firstTry, edited, rebuilt } = data.approvalFlow;
            const pct = (n: number) => (drafts > 0 ? (n / drafts) * 100 : 0);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div
                  style={{
                    display:      "flex",
                    width:        "100%",
                    height:       12,
                    borderRadius: 99,
                    overflow:     "hidden",
                    background:   C.surfaceB,
                  }}
                >
                  <div style={{ width: `${pct(firstTry)}%`, background: C.green }} />
                  <div style={{ width: `${pct(edited)}%`, background: C.amber }} />
                  <div style={{ width: `${pct(rebuilt)}%`, background: C.red }} />
                </div>
                <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                  <LegendItem color={C.green} label="First try" count={firstTry} />
                  <LegendItem color={C.amber} label="Edited" count={edited} />
                  <LegendItem color={C.red} label="Rebuilt" count={rebuilt} />
                </div>
              </div>
            );
          })()}

          <div style={{ fontSize: 12, color: C.t3 }}>
            On Aries for {data.approvalFlow.weeksOnAries} weeks
          </div>

          <Divider />

          {/* Learning curve */}
          <div>
            <div
              style={{
                fontSize:      12,
                color:         C.t3,
                fontWeight:    600,
                marginBottom:  10,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Learning curve
            </div>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <XAxis
                    dataKey="name"
                    tick={{ fill: C.t3, fontSize: 11 }}
                    axisLine={{ stroke: C.border }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: C.t3, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background:   C.surfaceB,
                      border:       `1px solid ${C.border}`,
                      borderRadius: 8,
                      fontSize:     12,
                      color:        C.t1,
                    }}
                    labelStyle={{ color: C.t3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke={C.accent}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ fontSize: 12, color: C.t3, padding: "12px 0" }}>
                Not enough approved posts yet to chart a learning curve.
              </div>
            )}
          </div>

          {/* Learnings (currently always empty — render only if present) */}
          {data.learnings.length > 0 && (
            <>
              <Divider />
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {data.learnings.map((l, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 16, lineHeight: 1.2 }}>{l.icon}</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>{l.title}</div>
                      <div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>{l.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
}
