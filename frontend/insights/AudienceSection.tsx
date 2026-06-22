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
import { C } from "@/frontend/insights/tokens";
import {
  SectionHeader,
  Panel,
  Pill,
  PlatformDot,
  ChannelIcon,
  ErrorState,
  EmptyState,
  LoadingRows,
  Divider,
} from "@/frontend/insights/ui";

interface AudienceSectionProps {
  period:   Period;
  platform: Platform;
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

function ScheduleRow({ item, last }: { item: AudienceScheduleItem; last: boolean }) {
  return (
    <div
      style={{
        display:      "flex",
        alignItems:   "center",
        gap:          10,
        padding:      "11px 0",
        borderBottom: last ? "none" : `1px solid ${C.border}`,
      }}
    >
      {item.platform === "all" ? (
        <ChannelIcon platform={item.platform} size={14} />
      ) : (
        <PlatformDot platform={item.platform} />
      )}
      <span
        style={{
          flex:         1,
          minWidth:     0,
          fontSize:     13,
          color:        C.t1,
          overflow:     "hidden",
          textOverflow: "ellipsis",
          whiteSpace:   "nowrap",
        }}
      >
        {item.title}
      </span>
      <span style={{ fontSize: 12, color: C.t3, flexShrink: 0 }}>
        {new Date(item.scheduledFor).toLocaleString()}
      </span>
      <span style={{ flexShrink: 0 }}>
        <Pill label={item.surface} color={C.accent} />
      </span>
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

export function AudienceSection({ period, platform }: AudienceSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<AudienceData>("audience", period, platform);

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
                gridTemplateColumns: "1fr 1fr",
                gap:                 28,
              }}
            >
              {/* LEFT — upcoming posts */}
              <div>
                <SubTitle>Upcoming posts</SubTitle>
                {!data?.schedule?.length ? (
                  <EmptyState message="No posts scheduled." />
                ) : (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {data.schedule.map((item, i) => (
                      <ScheduleRow
                        key={item.id}
                        item={item}
                        last={i === data.schedule.length - 1}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* RIGHT — demographics */}
              <div>
                <SubTitle>Demographics</SubTitle>
                {data?.demographics.hasData ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    {data.demographics.ages.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ fontSize: 11, color: C.t3 }}>Age</div>
                        {data.demographics.ages.map(([label, pct]) => (
                          <PercentBar key={label} label={label} pct={pct} />
                        ))}
                      </div>
                    )}
                    {data.demographics.locations.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ fontSize: 11, color: C.t3 }}>Location</div>
                        {data.demographics.locations.map(([label, pct]) => (
                          <PercentBar key={label} label={label} pct={pct} />
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <StubLine message="Demographics coming soon — connect Instagram/Facebook business accounts to unlock audience insights." />
                )}
              </div>
            </div>

            <Divider />

            {/* Active times (full width) */}
            <div>
              <SubTitle>Active times</SubTitle>
              {data?.activeTimes.hasData && data.activeTimes.grid ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, overflowX: "auto" }}>
                    {data.activeTimes.grid.map((row, di) => (
                      <div key={di} style={{ display: "flex", gap: 2 }}>
                        {row.map((score, hi) => (
                          <div
                            key={hi}
                            title={`${score}`}
                            style={{
                              width:        10,
                              height:       10,
                              borderRadius: 2,
                              background:   heatColor(score),
                              flexShrink:   0,
                            }}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                  {data.activeTimes.peakWindow && (
                    <div style={{ fontSize: 12, color: C.t2 }}>
                      Peak:{" "}
                      <strong style={{ color: C.t1 }}>
                        {data.activeTimes.peakWindow.day} {data.activeTimes.peakWindow.hour}
                      </strong>{" "}
                      <span style={{ color: C.t3 }}>({data.activeTimes.peakWindow.score})</span>
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
