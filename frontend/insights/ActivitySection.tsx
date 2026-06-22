// ─────────────────────────────────────────────────────────────────────────────
// ActivitySection.tsx
// What Aries did — activity strip + content mix donut
// API: GET /api/insights/activity?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform, ActivityData } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import {
  SectionHeader,
  Panel,
  Donut,
  Icon,
  ErrorState,
  EmptyState,
  LoadingRows,
  type IconName,
} from "@/frontend/insights/ui";

interface ActivitySectionProps {
  period:   Period;
  platform: Platform;
}

const MIX_PALETTE: string[] = [
  C.accent,
  C.accentB,
  C.green,
  C.amber,
  C.fbBlue,
  C.igPink,
];

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ActivitySection({ period, platform }: ActivitySectionProps) {
  const { data, loading, error, refetch } =
    useInsight<ActivityData>("activity", period, platform);

  return (
    <section>
      <SectionHeader title="What Aries did" />
      <Panel>
        {loading ? (
          <LoadingRows n={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : !data?.meta?.hasData ? (
          <EmptyState message="No posts published in this period." />
        ) : (
          <ActivityBody data={data} />
        )}
      </Panel>
    </section>
  );
}

// ── A richer metric card (replaces the plain MetricTile) ─────────────────────

function ActivityCard({
  icon,
  value,
  label,
  sub,
}: {
  icon:  IconName;
  value: string;
  label: string;
  sub?:  string;
}) {
  return (
    <div
      style={{
        background:    C.surfaceB,
        border:        `1px solid ${C.borderB}`,
        borderRadius:  12,
        padding:       "14px 16px",
        display:       "flex",
        flexDirection: "column",
        gap:           6,
      }}
    >
      <Icon name={icon} size={16} color={C.accentB} />
      <div
        style={{
          fontSize:           26,
          fontWeight:         800,
          color:              C.t1,
          lineHeight:         1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12.5, color: C.t2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: C.t3 }}>{sub}</div>}
    </div>
  );
}

function ActivityBody({ data }: { data: ActivityData }) {
  const mixSlices = data.contentMix.map((slice, i) => ({
    label: capitalize(slice.contentType),
    value: slice.count,
    color: MIX_PALETTE[i % MIX_PALETTE.length],
  }));
  const mixTotal = data.contentMix.reduce((s, x) => s + x.count, 0);

  return (
    <div
      style={{
        display:             "grid",
        gridTemplateColumns: "1.4fr 1fr",
        gap:                 28,
      }}
    >
      {/* ── LEFT: rich metric cards + footer ───────────────────────────────── */}
      <div>
        <div
          style={{
            display:             "grid",
            gridTemplateColumns: "1fr 1fr",
            gap:                 12,
          }}
        >
          <ActivityCard
            icon="post"
            value={data.strip.postsPublished.toLocaleString()}
            label="Posts published"
            sub={`across ${data.meta.platformCount} channel${data.meta.platformCount === 1 ? "" : "s"}`}
          />
          <ActivityCard
            icon="comment"
            value={data.strip.commentsReceived.toLocaleString()}
            label="Comments received"
          />
          <ActivityCard
            icon="spark"
            value={data.strip.highPerformers.toLocaleString()}
            label="High performers"
            sub="≥2× average reach"
          />
          <ActivityCard
            icon="clock"
            value={data.strip.hoursSaved.toLocaleString()}
            label="Hours saved"
            sub="~3 hrs per post"
          />
        </div>

        {data.footerLine && (
          <div style={{ fontSize: 12, color: C.t3, lineHeight: 1.5, marginTop: 14 }}>
            {data.footerLine}
          </div>
        )}

        {data.meta.pendingClassification > 0 && (
          <div style={{ fontSize: 11, color: C.t3, marginTop: 8 }}>
            {data.meta.pendingClassification} posts pending classification
          </div>
        )}
      </div>

      {/* ── RIGHT: content mix donut + legend ──────────────────────────────── */}
      <div
        style={{
          borderLeft:    `1px solid ${C.border}`,
          paddingLeft:   24,
          display:       "flex",
          flexDirection: "column",
          gap:           16,
        }}
      >
        <div
          style={{
            fontSize:      11,
            fontWeight:    600,
            color:         C.t3,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Content mix
        </div>

        {mixSlices.length > 0 ? (
          <>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Donut
                slices={mixSlices}
                centerTop={mixTotal.toLocaleString()}
                centerBottom="posts"
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {data.contentMix.map((slice, i) => (
                <div
                  key={slice.contentType}
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <span
                    style={{
                      display:      "inline-block",
                      width:        9,
                      height:       9,
                      borderRadius: "50%",
                      background:   MIX_PALETTE[i % MIX_PALETTE.length],
                      flexShrink:   0,
                    }}
                  />
                  <span style={{ fontSize: 12, color: C.t2 }}>
                    {capitalize(slice.contentType)}
                  </span>
                  <span
                    style={{
                      marginLeft:         "auto",
                      fontSize:           12,
                      fontWeight:         600,
                      color:              C.t1,
                      textAlign:          "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {slice.pct}%
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: C.t3 }}>No content yet.</div>
        )}
      </div>
    </div>
  );
}
