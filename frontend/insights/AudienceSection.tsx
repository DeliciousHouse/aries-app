// ─────────────────────────────────────────────────────────────────────────────
// AudienceSection.tsx
// Section 9 — Upcoming schedule + audience demographics + active times
// API: GET /api/insights/audience?period=…&platform=… (uncached endpoint)
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Period,
  Platform,
  AudienceData,
  AudienceScheduleItem,
} from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { useTenantTimezone } from "@/hooks/use-tenant-timezone";
import { C, platformLabel } from "@/frontend/insights/tokens";
import {
  SectionHeader,
  Panel,
  ChannelIcon,
  Icon,
  ErrorState,
  EmptyState,
  LoadingRows,
  Divider,
} from "@/frontend/insights/ui";
import type { IconName } from "@/frontend/insights/ui";

interface AudienceSectionProps {
  period:   Period;
  platform: Platform;
}

// Block header with icon badge + title + subtitle (matches the mock's
// "Who's listening" / "Aries' publishing schedule" headings).
function BlockHeader({ icon, title, subtitle }: { icon: IconName; title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 28, height: 28, borderRadius: 8, background: `${C.accent}1c`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon name={icon} size={15} color={C.accentB} />
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, color: C.t1 }}>{title}</span>
      </div>
      <div style={{ fontSize: 12, color: C.t3, marginTop: 6 }}>{subtitle}</div>
    </div>
  );
}

// feed | story | reel → display label for the card sub-line.
function surfaceLabel(surface: string): string {
  switch (surface) {
    case "story": return "Story";
    case "reel":  return "Reel";
    default:      return "Feed post";
  }
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

// Platform chip shown top-right of each card: brand logo + uppercase label.
function PlatformChip({ platform }: { platform: string }) {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
        background: C.surfaceB, border: `1px solid ${C.border}`, borderRadius: 99,
        padding: "4px 10px",
      }}
    >
      <ChannelIcon platform={platform} size={12} />
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: C.t2 }}>
        {platformLabel[platform] ?? platform}
      </span>
    </span>
  );
}

function ScheduleCard({ item }: { item: AudienceScheduleItem }) {
  const when = new Date(item.scheduledFor);
  const dayLabel = when.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const timeLabel = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        background: C.surface,
        padding: "16px 18px",
      }}
    >
      {/* Top row — date · time (left) + platform chip (right) */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 12.5, color: C.t2, fontWeight: 500 }}>
          {dayLabel} {" · "}
          <span style={{ color: C.accentB, fontWeight: 600 }}>{timeLabel}</span>
        </div>
        <PlatformChip platform={item.platform} />
      </div>

      {/* Title + surface sub-line */}
      <div style={{ fontSize: 15, fontWeight: 600, color: C.t1, marginTop: 12, lineHeight: 1.35 }}>
        {item.title}
      </div>
      <div style={{ fontSize: 12, color: C.t3, marginTop: 4 }}>{surfaceLabel(item.surface)}</div>

      {/* Aries timing rationale — only when stored (not fabricated). */}
      {item.reason && (
        <div
          style={{
            display: "flex", gap: 8, alignItems: "flex-start",
            marginTop: 14, paddingTop: 13, borderTop: `1px dashed ${C.border}`,
          }}
        >
          <span style={{ flexShrink: 0, marginTop: 1 }}>
            <Icon name="spark" size={13} color={C.accentB} />
          </span>
          <div style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.5 }}>
            <strong style={{ color: C.t1, fontWeight: 600 }}>Aries:</strong> {item.reason}
          </div>
        </div>
      )}
    </div>
  );
}

function PercentBar({ label, pct }: { label: string; pct: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span style={{ color: C.t2 }}>{label}</span>
        <span style={{ color: C.t1, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
          {pct}%
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 99, background: C.track, overflow: "hidden" }}>
        <div
          style={{
            width:        `${Math.min(Math.max(pct, 0), 100)}%`,
            height:       "100%",
            background:   `linear-gradient(90deg, ${C.accentDim}, ${C.accentB})`,
            borderRadius: 99,
          }}
        />
      </div>
    </div>
  );
}

function StubLine({ message }: { message: string }) {
  return (
    <p style={{ margin: 0, fontSize: 13, color: C.t3, lineHeight: 1.6 }}>{message}</p>
  );
}

function heatColor(score: number): string {
  // 0–100 → translucent accent ramp
  const alpha = Math.round((Math.min(Math.max(score, 0), 100) / 100) * 90 + 6);
  return `${C.accent}${alpha.toString(16).padStart(2, "0")}`;
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21];

function fmtHourShort(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${h < 12 ? "am" : "pm"}`;
}

// 7×24 engagement heatmap with day-axis (Mon..Sun) + hour-axis ticks.
function Heatmap({ grid }: { grid: number[][] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowX: "auto" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 520 }}>
        {grid.map((row, di) => (
          <div key={di} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 30, fontSize: 11, color: C.t3, flexShrink: 0, textAlign: "right" }}>
              {DAY_LABELS[di]}
            </span>
            <div style={{ display: "flex", gap: 3, flex: 1 }}>
              {row.map((score, hi) => (
                <div
                  key={hi}
                  title={`${DAY_LABELS[di]} ${fmtHourShort(hi)}`}
                  style={{
                    flex:         1,
                    height:       18,
                    borderRadius: 3,
                    background:   heatColor(score),
                    border:       score >= 100 ? `1px solid ${C.green}` : "1px solid transparent",
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        {/* Hour-axis ticks */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          <span style={{ width: 30, flexShrink: 0 }} />
          <div style={{ position: "relative", flex: 1, height: 14 }}>
            {HOUR_TICKS.map((h) => (
              <span
                key={h}
                style={{ position: "absolute", left: `${(h / 24) * 100}%`, fontSize: 10, color: C.t3 }}
              >
                {fmtHourShort(h)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function HeatLegend() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, color: C.t3 }}>Less active</span>
      <div style={{ display: "flex", gap: 3 }}>
        {[10, 35, 60, 85, 100].map((s) => (
          <span key={s} style={{ width: 16, height: 10, borderRadius: 2, background: heatColor(s) }} />
        ))}
      </div>
      <span style={{ fontSize: 11, color: C.t3 }}>More active</span>
    </div>
  );
}

export function AudienceSection({ period, platform }: AudienceSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<AudienceData>("audience", period, platform);
  const tenantTimeZone = useTenantTimezone();
  const activeTimesZone = data?.activeTimes.timezone || tenantTimeZone;
  const activeTimesSubtitle =
    activeTimesZone === tenantTimeZone
      ? `Activity by day & hour · times in ${tenantTimeZone}`
      : `Activity by day & hour · audience data in ${activeTimesZone}; business timezone is ${tenantTimeZone}`;

  return (
    <section>
      <SectionHeader title="Audience" />
      <Panel>
        {loading ? (
          <LoadingRows n={5} />
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <div
              style={{
                display:             "grid",
                gridTemplateColumns: "1fr 1.15fr",
                gap:                 32,
                alignItems:          "start",
              }}
            >
              {/* LEFT — who's listening (demographics) */}
              <div>
                <BlockHeader icon="users" title="Who's listening" subtitle="Your audience composition, refreshed weekly" />
                {data?.demographics.hasData ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                    {data.demographics.ages.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                        <SubTitle>Age</SubTitle>
                        {data.demographics.ages.map(([label, pct]) => (
                          <PercentBar key={label} label={label} pct={pct} />
                        ))}
                      </div>
                    )}
                    {data.demographics.locations.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                        <SubTitle>Top locations</SubTitle>
                        {data.demographics.locations.map(([label, pct]) => (
                          <PercentBar key={label} label={label} pct={pct} />
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <StubLine message="Audience demographics coming soon — we're still building this insight." />
                )}
              </div>

              {/* RIGHT — Aries' publishing schedule */}
              <div>
                <BlockHeader icon="calendar" title="Aries' publishing schedule" subtitle="Next posts, scheduled in your audience's peak windows" />
                {!data?.schedule?.length ? (
                  <EmptyState message="No posts scheduled." />
                ) : (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {data.schedule.map((item) => (
                        <ScheduleCard key={item.id} item={item} />
                      ))}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 16 }}>
                      <a
                        href="/calendar"
                        style={{ fontSize: 12.5, fontWeight: 600, color: C.accentB, textDecoration: "none" }}
                      >
                        See full calendar →
                      </a>
                      <span style={{ fontSize: 11, color: C.t3 }}>You can override any slot from Calendar</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            <Divider />

            {/* When they're listening — engagement-timing heatmap (full width) */}
            <div>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <BlockHeader
                  icon="clock"
                  title="When they're listening"
                  subtitle={activeTimesSubtitle}
                />
                {data?.activeTimes.hasData && data.activeTimes.peakWindow && (
                  <span
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
                      background: `${C.green}1c`, border: `1px solid ${C.green}3a`,
                      borderRadius: 99, padding: "5px 11px",
                    }}
                  >
                    <Icon name="spark" size={12} color={C.green} />
                    <span style={{ fontSize: 11.5, color: C.t1, fontWeight: 600 }}>
                      Peak: {data.activeTimes.peakWindow.day} {data.activeTimes.peakWindow.hour}
                    </span>
                  </span>
                )}
              </div>

              {data?.activeTimes.hasData && data.activeTimes.grid ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <Heatmap grid={data.activeTimes.grid} />
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <HeatLegend />
                  </div>
                  {data.activeTimes.peakWindow && (
                    <div
                      style={{
                        display: "flex", gap: 8, alignItems: "flex-start",
                        background: C.surfaceB, border: `1px solid ${C.border}`,
                        borderRadius: 10, padding: "12px 14px",
                      }}
                    >
                      <span style={{ flexShrink: 0, marginTop: 1 }}>
                        <Icon name="spark" size={13} color={C.accentB} />
                      </span>
                      <div style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.55 }}>
                        <strong style={{ color: C.t1, fontWeight: 600 }}>Aries:</strong>{" "}
                        {data.activeTimes.peakWindow.day} around {data.activeTimes.peakWindow.hour} is
                        when your audience engages most. Aries leans new posts toward this window.
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <StubLine message="Active-times analysis available after more tracking — check back soon." />
              )}
            </div>
          </div>
        )}
      </Panel>
    </section>
  );
}
