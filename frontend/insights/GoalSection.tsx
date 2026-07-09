// ─────────────────────────────────────────────────────────────────────────────
// GoalSection.tsx
// Section 2 — Your goal: the outcome metric Aries is driving toward.
// API: GET /api/insights/goal?period=…&platform=…
//
// "What contributed" adapts to the period:
//   • this week  → individual posts (few posts, names are meaningful)
//   • 30/90 days → content categories (too many posts to name individually)
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform, GoalData } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C, platformLabel } from "@/frontend/insights/tokens";
import {
  SectionHeader, Panel, ChannelIcon, Icon, ErrorState, EmptyState, LoadingRows,
} from "@/frontend/insights/ui";
// S1-9-PROVISIONAL-DISCLOSURE — REMOVE IN S2-1 (Gap A1 fix).
import { ProvisionalMetricNote } from "@/frontend/insights/ProvisionalMetricNote";

interface GoalSectionProps {
  period:   Period;
  platform: Platform;
}

const PERIOD_TITLE: Record<Period, string> = {
  week:    "this week",
  "30day": "last 30 days",
  "90day": "last 90 days",
};

const PERIOD_PRIOR: Record<Period, string> = {
  week:    "last week",
  "30day": "prior 30 days",
  "90day": "prior 90 days",
};

// Short imperative phrasing for the goal eyebrow (mock: "YOUR GOAL · GET LEADS").
const GOAL_VERB: Record<string, string> = {
  lead_generation: "Get leads",
  content_growth:  "Grow audience",
  product_sales:   "Drive sales",
  brand_awareness: "Build awareness",
};

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Singularize the metric label when the value is exactly 1 ("1 lead"). */
function unit(label: string, value: number): string {
  if (value !== 1) return label;
  return label.endsWith("s") ? label.slice(0, -1) : label;
}

function ComparisonBadge({ data, period }: { data: GoalData; period: Period }) {
  const abs = data.metricValue - data.metricValuePrev;
  const up  = abs >= 0;
  // Week → absolute ("+2 vs last week"); longer periods → % unless prior was 0.
  let text: string;
  if (period === "week" || data.metricValuePrev === 0) {
    text = `${up ? "+" : ""}${abs} vs ${PERIOD_PRIOR[period]}`;
  } else {
    text = `${data.metricDelta >= 0 ? "+" : ""}${data.metricDelta}% vs ${PERIOD_PRIOR[period]}`;
  }
  const color = up ? C.green : C.red;
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 12.5, fontWeight: 600, color,
        background: `${color}1c`, borderRadius: 99, padding: "3px 10px",
      }}
    >
      {up ? "▲" : "▼"} {text}
    </span>
  );
}

export function GoalSection({ period, platform }: GoalSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<GoalData>("goal", period, platform);

  const goalVerb = data?.goal ? (GOAL_VERB[data.goal] ?? data.goalLabel ?? "") : "";
  const displayLabel =
    data?.goal === "lead_generation" ? "likely leads" : (data?.metricLabel ?? "");
  const useCategories = period !== "week";
  const channelContext = platform === "all" ? "All channels" : (platformLabel[platform] ?? platform);
  // Defensive: a stale cached body (pre-v2) may lack these arrays.
  const categories   = data?.categories   ?? [];
  const contributors = data?.contributors ?? [];

  return (
    <section>
      <SectionHeader
        title={`Your goal · ${PERIOD_TITLE[period]}`}
        note="Outcome Aries is delivering for what you signed up for"
      />
      <Panel>
        {loading ? (
          <LoadingRows n={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : !data || data.status === "no_goal" ? (
          <EmptyState message="No primary goal set. Go to Settings to configure your goal." />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
            {/* ── LEFT: the headline metric ── */}
            <div style={{ display: "flex", flexDirection: "column", paddingRight: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 14 }}>
                <span style={{ color: C.t3 }}>YOUR GOAL</span>
                <span style={{ color: C.t3 }}>{"  ·  "}</span>
                <span style={{ color: C.accentB, textTransform: "uppercase" }}>{goalVerb}</span>
              </div>

              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: 48, fontWeight: 800, color: C.t1, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                  {data.metricValue.toLocaleString()}
                </span>
                <span style={{ fontSize: 15, color: C.t2 }}>{displayLabel}</span>
                <ComparisonBadge data={data} period={period} />
              </div>

              {data.secondaryValue != null && (
                <div style={{ fontSize: 12.5, color: C.t3, marginTop: 8 }}>
                  {data.secondaryValue.toLocaleString()} {data.secondaryLabel}
                </div>
              )}

              {/* Aries narrative — own inset card with a spark icon */}
              <div
                style={{
                  display: "flex", gap: 10, marginTop: 18,
                  background: C.surfaceB, border: `1px solid ${C.borderB}`,
                  borderRadius: 10, padding: "13px 15px",
                }}
              >
                <span style={{ flexShrink: 0, marginTop: 1 }}>
                  <Icon name="spark" size={15} color={C.accentB} />
                </span>
                <p style={{ margin: 0, fontSize: 13, color: C.t2, lineHeight: 1.55 }}>
                  <span style={{ color: C.accentB, fontWeight: 600 }}>Aries: </span>
                  {data.ariesLine}
                </p>
              </div>

              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.t3, marginTop: 16 }}>
                <Icon name="info" size={12} color={C.t3} />
                Aries-classified — verify on Conversations before reaching out.
              </div>
            </div>

            {/* ── RIGHT: what contributed ── */}
            <div style={{ borderLeft: `1px solid ${C.border}`, paddingLeft: 28 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: C.t3, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                  What contributed
                </span>
                {/* S1-9-PROVISIONAL-DISCLOSURE — REMOVE IN S2-1 (Gap A1 fix):
                    contributor/category values are per-post lifetime-SUM reach/
                    saves (over-count). The goal headline metric is account-level
                    and is NOT labelled here. */}
                <ProvisionalMetricNote />
              </div>

              <div style={{ display: "flex", flexDirection: "column" }}>
                {useCategories
                  ? categories.map((cat, i) => (
                      <ContribRow
                        key={cat.contentType}
                        primary={`${cat.label} (${cat.postCount} ${cat.postCount === 1 ? "post" : "posts"})`}
                        sub={`${channelContext} · ${cat.label}`}
                        value={cat.metricValue}
                        unitLabel={unit(cat.metricLabel, cat.metricValue)}
                        last={i === categories.length - 1}
                      />
                    ))
                  : contributors.map((c, i) => (
                      <ContribRow
                        key={`${c.title}-${i}`}
                        primary={c.title}
                        subIcon={c.platform}
                        sub={`${platformLabel[c.platform] ?? titleCase(c.platform)}${c.contentType ? ` · ${titleCase(c.contentType)}` : ""}`}
                        value={c.metricValue}
                        unitLabel={unit(c.metricLabel, c.metricValue)}
                        last={i === contributors.length - 1}
                      />
                    ))}
                {(useCategories ? categories.length === 0 : contributors.length === 0) && (
                  <div style={{ fontSize: 12.5, color: C.t3 }}>No contributing posts yet.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </Panel>
    </section>
  );
}

function ContribRow({
  primary, sub, subIcon, value, unitLabel, last,
}: {
  primary:   string;
  sub:       string;
  subIcon?:  string;
  value:     number;
  unitLabel: string;
  last:      boolean;
}) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "13px 0",
        borderBottom: last ? "none" : `1px solid ${C.border}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, color: C.t1, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {primary}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: C.t3, marginTop: 3 }}>
          {subIcon && <ChannelIcon platform={subIcon} size={12} />}
          {sub}
        </div>
      </div>
      <div style={{ flexShrink: 0, textAlign: "right" }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: C.t1, fontVariantNumeric: "tabular-nums" }}>
          {value.toLocaleString()}
        </span>{" "}
        <span style={{ fontSize: 12, color: C.t3 }}>{unitLabel}</span>
      </div>
    </div>
  );
}
