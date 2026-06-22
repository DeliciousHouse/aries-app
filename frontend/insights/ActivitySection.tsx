// ─────────────────────────────────────────────────────────────────────────────
// ActivitySection.tsx
// What Aries did — activity strip + content mix breakdown
// API: GET /api/insights/activity?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform, ActivityData } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import {
  SectionCard,
  MetricTile,
  ErrorState,
  EmptyState,
  Skeleton,
} from "@/frontend/insights/ui";

interface ActivitySectionProps {
  period:   Period;
  platform: Platform;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ActivitySection({ period, platform }: ActivitySectionProps) {
  const { data, loading, error, refetch } =
    useInsight<ActivityData>("activity", period, platform);

  return (
    <SectionCard title="Activity" eyebrow="What Aries did">
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[1, 2, 3, 4].map((n) => <Skeleton key={n} h={80} />)}
          </div>
          <Skeleton h={120} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : !data?.meta?.hasData ? (
        <EmptyState message="No posts published in this period." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 2×2 strip */}
          <div
            style={{
              display:             "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap:                 12,
            }}
          >
            <MetricTile
              label="Posts published"
              value={data.strip.postsPublished.toLocaleString()}
            />
            <MetricTile
              label="Comments received"
              value={data.strip.commentsReceived.toLocaleString()}
            />
            <MetricTile
              label="High performers"
              value={data.strip.highPerformers.toLocaleString()}
            />
            <MetricTile
              label="Hours saved"
              value={data.strip.hoursSaved.toLocaleString()}
            />
          </div>

          {/* Footer line */}
          {data.footerLine && (
            <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.5 }}>
              {data.footerLine}
            </div>
          )}

          {/* Content mix breakdown */}
          {data.contentMix.length > 0 && (
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
                Content mix
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {data.contentMix.map((slice) => (
                  <div
                    key={slice.contentType}
                    style={{ display: "flex", flexDirection: "column", gap: 5 }}
                  >
                    <div
                      style={{
                        display:        "flex",
                        justifyContent: "space-between",
                        fontSize:       12,
                        color:          C.t2,
                      }}
                    >
                      <span>{capitalize(slice.contentType)}</span>
                      <span style={{ color: C.t1, fontWeight: 600 }}>
                        {slice.count.toLocaleString()}
                      </span>
                    </div>
                    <div
                      style={{
                        height:       6,
                        borderRadius: 99,
                        background:   C.surfaceB,
                        overflow:     "hidden",
                      }}
                    >
                      <div
                        style={{
                          width:        `${slice.pct}%`,
                          height:       "100%",
                          borderRadius: 99,
                          background:   C.accent,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pending classification nudge */}
          {data.meta.pendingClassification > 0 && (
            <div style={{ fontSize: 11, color: C.t3 }}>
              {data.meta.pendingClassification} posts pending classification
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
