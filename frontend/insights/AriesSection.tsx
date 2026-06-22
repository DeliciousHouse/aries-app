// ─────────────────────────────────────────────────────────────────────────────
// AriesSection.tsx
// Section 8 — Working with Aries: AI adoption + approval flow (uncached endpoint)
// API: GET /api/insights/aries?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform, AriesData } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import {
  SectionHeader,
  Panel,
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
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

interface AriesSectionProps {
  period:   Period;
  platform: Platform;
}

function LegendItem({
  color,
  label,
  count,
  pct,
}: {
  color: string;
  label: string;
  count: number;
  pct:   number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: C.t2, flex: 1 }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.t1, fontVariantNumeric: "tabular-nums" }}>
        {count}
      </span>
      <span style={{ fontSize: 11, color: C.t3, fontVariantNumeric: "tabular-nums", minWidth: 34, textAlign: "right" }}>
        {pct}%
      </span>
    </div>
  );
}

function SubTitle({ children }: { children: string }) {
  return (
    <div
      style={{
        fontSize:      10.5,
        fontWeight:    700,
        color:         C.t3,
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        marginBottom:  12,
      }}
    >
      {children}
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
    <section>
      <SectionHeader title="Working with Aries" />
      <Panel>
        {loading ? (
          <LoadingRows n={3} />
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : empty || !data ? (
          <EmptyState message="No Aries activity recorded this period." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <div
              style={{
                display:             "grid",
                gridTemplateColumns: "1fr 1fr",
                gap:                 28,
              }}
            >
              {/* LEFT — approval flow */}
              <div>
                <SubTitle>Approval flow</SubTitle>
                {(() => {
                  const { drafts, firstTry, edited, rebuilt } = data.approvalFlow;
                  const pct = (n: number) => (drafts > 0 ? Math.round((n / drafts) * 100) : 0);
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 30, fontWeight: 800, color: C.t1, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                          {data.approvalFlow.firstTryRate}%
                        </span>
                        <span style={{ fontSize: 13, color: C.t2 }}>first-try approval</span>
                        <DeltaBadge
                          delta={data.approvalFlow.firstTryRate - data.approvalFlow.firstTryRatePriorPeriod}
                        />
                      </div>

                      <div
                        style={{
                          display:      "flex",
                          width:        "100%",
                          height:       12,
                          borderRadius: 99,
                          overflow:     "hidden",
                          background:   C.track,
                        }}
                      >
                        <div style={{ width: `${pct(firstTry)}%`, background: C.green }} />
                        <div style={{ width: `${pct(edited)}%`, background: C.amber }} />
                        <div style={{ width: `${pct(rebuilt)}%`, background: C.red }} />
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <LegendItem color={C.green} label="First try" count={firstTry} pct={pct(firstTry)} />
                        <LegendItem color={C.amber} label="Edited"    count={edited}   pct={pct(edited)} />
                        <LegendItem color={C.red}   label="Rebuilt"   count={rebuilt}  pct={pct(rebuilt)} />
                      </div>

                      <div style={{ fontSize: 12, color: C.t3 }}>
                        On Aries for {data.approvalFlow.weeksOnAries} weeks
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* RIGHT — what Aries picked up */}
              <div>
                <SubTitle>What Aries picked up</SubTitle>
                {data.learnings.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {data.learnings.map((l, i) => (
                      <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <span style={{ fontSize: 16, lineHeight: 1.2 }}>{l.icon}</span>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>{l.title}</div>
                          <div style={{ fontSize: 12, color: C.t2, marginTop: 2, lineHeight: 1.5 }}>{l.body}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: 13, color: C.t3, lineHeight: 1.6 }}>
                    Aries is still learning your preferences — picks up patterns as you review more posts.
                  </p>
                )}
              </div>
            </div>

            <Divider />

            {/* Learning curve */}
            <div>
              <SubTitle>Learning curve</SubTitle>
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
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
                <p style={{ margin: 0, fontSize: 13, color: C.t3, padding: "12px 0", lineHeight: 1.6 }}>
                  Not enough approved posts yet to chart a learning curve.
                </p>
              )}
            </div>
          </div>
        )}
      </Panel>
    </section>
  );
}
