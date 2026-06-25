// ─────────────────────────────────────────────────────────────────────────────
// ActivitySection.tsx
// "What Aries did" — activity metrics (left panel) + content mix donut (right panel)
// API: GET /api/insights/activity?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";
import type { Period, Platform, ActivityData } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import {
  SectionHeader, Panel, Donut, Icon, ChannelIcon, ErrorState, EmptyState, LoadingRows,
} from "@/frontend/insights/ui";

interface ActivitySectionProps {
  period:   Period;
  platform: Platform;
}

const PERIOD_TITLE: Record<Period, string> = {
  week:    "What Aries did this week",
  "30day": "What Aries did this month",
  "90day": "What Aries did over 90 days",
};

const PERIOD_DAYS: Record<Period, number> = { week: 7, "30day": 30, "90day": 90 };

const MIX_PALETTE = [C.accent, C.accentB, C.green, C.amber, C.fbBlue, C.igPink];

function fmtRange(period: Period): string {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - PERIOD_DAYS[period]);
  const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(start)} – ${f(end)}`;
}

function titleCase(s: string): string {
  if (s === "uncategorized") return "Other";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── A single metric card (icon · number · label · sub) ───────────────────────
function MetricCard({
  icon, value, label, children,
}: {
  icon: string;
  value: ReactNode;
  label: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        background: C.surfaceB, border: `1px solid ${C.borderB}`, borderRadius: 12,
        padding: "16px 18px", display: "flex", flexDirection: "column", gap: 7,
      }}
    >
      <span
        style={{
          width: 30, height: 30, borderRadius: 8, background: `${C.accent}1c`,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <Icon name={icon} size={15} color={C.accentB} />
      </span>
      <div style={{ fontSize: 27, fontWeight: 800, color: C.t1, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: 12.5, color: C.t2 }}>{label}</div>
      {children}
    </div>
  );
}

export function ActivitySection({ period, platform }: ActivitySectionProps) {
  const { data, loading, error, refetch } =
    useInsight<ActivityData>("activity", period, platform);

  const platforms = data?.meta?.platforms ?? [];
  const mixTotal  = (data?.contentMix ?? []).reduce((s, m) => s + m.count, 0);

  return (
    <section>
      <SectionHeader title={PERIOD_TITLE[period]} note={`${fmtRange(period)} · running on Aries Pro`} />

      {loading ? (
        <Panel><LoadingRows n={4} /></Panel>
      ) : error ? (
        <Panel><ErrorState message={error} onRetry={refetch} /></Panel>
      ) : !data?.meta?.hasData ? (
        <Panel><EmptyState message="No Aries-published posts in this period." /></Panel>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1.55fr 1fr", gap: 20, alignItems: "stretch" }}>
          {/* ── LEFT panel: metric cards + insight footer ── */}
          <Panel style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <MetricCard icon="post" value={data.strip.postsPublished.toLocaleString()} label="Aries-published posts">
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                  <span style={{ display: "inline-flex", gap: 3 }}>
                    {platforms.map((p) => <ChannelIcon key={p} platform={p} size={13} />)}
                  </span>
                  <span style={{ fontSize: 11, color: C.t3 }}>
                    across {data.meta.platformCount} {data.meta.platformCount === 1 ? "platform" : "platforms"}
                  </span>
                </div>
              </MetricCard>

              <MetricCard icon="comment" value={data.strip.commentsReceived.toLocaleString()} label="Comments received">
                <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>
                  {data.strip.commentsHandled} handled{" · "}
                  <span style={{ color: C.amber, fontWeight: 600 }}>{data.strip.commentsNeedReply} need you</span>
                </div>
              </MetricCard>

              <MetricCard icon="spark" value={data.strip.highPerformers.toLocaleString()} label="High performers spotted">
                <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>posts beating your baseline by 2× or more</div>
              </MetricCard>

              <MetricCard
                icon="clock"
                value={<>~{data.strip.hoursSaved}<span style={{ fontSize: 15, fontWeight: 600 }}>h</span></>}
                label="Hours saved"
              >
                <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>writing, scheduling, replying, analyzing</div>
              </MetricCard>
            </div>

            <div style={{ flex: 1 }} />
            <div style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 12, color: C.t3, borderTop: `1px solid ${C.border}`, paddingTop: 14, lineHeight: 1.5 }}>
              <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="info" size={13} color={C.t3} /></span>
              {data.footerLine}
            </div>
          </Panel>

          {/* ── RIGHT panel: content mix ── */}
          <Panel style={{ display: "flex", flexDirection: "column", background: `linear-gradient(160deg, ${C.surface} 60%, #1b1430)` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 26, height: 26, borderRadius: 7, background: `${C.accent}1c`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <MixGlyph />
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>Content mix</span>
            </div>
            <div style={{ fontSize: 11.5, color: C.t3, marginTop: 4, marginBottom: 18 }}>
              What kinds of posts Aries shipped
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
              <Donut
                slices={(data.contentMix ?? []).map((m, i) => ({
                  label: titleCase(m.contentType),
                  value: m.count,
                  color: MIX_PALETTE[i % MIX_PALETTE.length],
                }))}
                size={124}
                thickness={15}
                centerTop={mixTotal}
                centerBottom="POSTS"
              />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 11 }}>
                {(data.contentMix ?? []).map((m, i) => (
                  <div key={m.contentType} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: MIX_PALETTE[i % MIX_PALETTE.length], flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 13, color: C.t2 }}>{titleCase(m.contentType)}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.t1, fontVariantNumeric: "tabular-nums" }}>{m.pct}%</span>
                  </div>
                ))}
                {(data.contentMix ?? []).length === 0 && (
                  <span style={{ fontSize: 12.5, color: C.t3 }}>No classified posts yet.</span>
                )}
              </div>
            </div>

            {data.meta.pendingClassification > 0 && (
              <div style={{ fontSize: 11, color: C.t3, marginTop: 16 }}>
                {data.meta.pendingClassification} post{data.meta.pendingClassification === 1 ? "" : "s"} pending classification
              </div>
            )}
          </Panel>
        </div>
      )}
    </section>
  );
}

// Small ring-with-crosshair glyph for the Content mix header.
function MixGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke={C.accentB} strokeWidth="2" />
      <path d="M12 2v20M2 12h20" stroke={C.accentB} strokeWidth="1.4" opacity="0.5" />
    </svg>
  );
}
