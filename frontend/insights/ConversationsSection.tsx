// ─────────────────────────────────────────────────────────────────────────────
// ConversationsSection.tsx
// Section 7 — Comment engagement and lead detection (uncached endpoint)
// API: GET /api/insights/conversations?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Period,
  Platform,
  ConversationsData,
  ConversationItem,
  LeadQualityItem,
} from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C, platformColor } from "@/frontend/insights/tokens";
import {
  SectionCard,
  ErrorState,
  EmptyState,
  LoadingRows,
  Divider,
} from "@/frontend/insights/ui";

interface ConversationsSectionProps {
  period:   Period;
  platform: Platform;
}

function tagColor(tag: string | null): string {
  switch (tag) {
    case "lead":     return C.green;
    case "question": return C.accent;
    case "positive": return C.amber;
    default:         return C.t3;
  }
}

function ConversationRow({ item, platform }: { item: ConversationItem; platform: Platform }) {
  const bubbleColor = platformColor[platform] ?? C.accent;
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div
        style={{
          width:          34,
          height:         34,
          borderRadius:   "50%",
          flexShrink:     0,
          display:        "flex",
          alignItems:     "center",
          justifyContent: "center",
          fontSize:       12,
          fontWeight:     700,
          color:          C.t1,
          background:     `${bubbleColor}28`,
          border:         `1px solid ${bubbleColor}50`,
        }}
      >
        {item.avatar}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>{item.author}</span>
          <span style={{ fontSize: 11, color: C.t3 }}>{item.timeAgo}</span>
          {item.tagLabel && (
            <span
              style={{
                fontSize:     10,
                fontWeight:   700,
                padding:      "2px 7px",
                borderRadius: 99,
                color:        tagColor(item.tag),
                background:   `${tagColor(item.tag)}1e`,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {item.tagLabel}
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: C.t2, marginTop: 4, lineHeight: 1.45 }}>
          {item.text}
        </div>
        <div
          style={{
            display:    "flex",
            alignItems: "center",
            gap:        10,
            marginTop:  6,
          }}
        >
          <span style={{ fontSize: 11, color: C.t3 }}>re: {item.postRef}</span>
          <span
            style={{
              fontSize:   11,
              fontWeight: 600,
              color:      item.handled ? C.t3 : C.amber,
            }}
          >
            {item.handled ? "Replied" : "Needs reply"}
          </span>
        </div>
      </div>
    </div>
  );
}

function LeadQualityRow({ item }: { item: LeadQualityItem }) {
  return (
    <div
      style={{
        display:    "flex",
        alignItems: "center",
        gap:        12,
        padding:    "8px 0",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: C.t1, fontWeight: 500 }}>{item.label}</div>
        <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>{item.note}</div>
      </div>
      <span
        style={{
          fontSize:           12,
          fontWeight:         700,
          color:              C.t1,
          background:         C.surfaceB,
          border:             `1px solid ${C.borderB}`,
          padding:            "2px 9px",
          borderRadius:       99,
          fontVariantNumeric: "tabular-nums",
          flexShrink:         0,
        }}
      >
        {item.count}
      </span>
    </div>
  );
}

export function ConversationsSection({ period, platform }: ConversationsSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<ConversationsData>("conversations", period, platform);

  return (
    <SectionCard title="Conversations" eyebrow="Comment insights">
      {loading ? (
        <LoadingRows n={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : !data?.conversations?.length ? (
        <EmptyState message="No comments recorded in this period." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Meta summary row */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 22, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: C.t1, fontVariantNumeric: "tabular-nums" }}>
                {data.meta.total.toLocaleString()}
              </span>
              <span style={{ fontSize: 12, color: C.t3 }}>comments</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span
                style={{
                  fontSize:           22,
                  fontWeight:         700,
                  color:              data.meta.needsReply > 0 ? C.amber : C.t1,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {data.meta.needsReply.toLocaleString()}
              </span>
              <span style={{ fontSize: 12, color: C.t3 }}>need a reply</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: C.t1, fontVariantNumeric: "tabular-nums" }}>
                {data.meta.positivePercent}%
              </span>
              <span style={{ fontSize: 12, color: C.t3 }}>positive</span>
            </div>
          </div>

          {/* Conversation feed */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {data.conversations.map((item) => (
              <ConversationRow key={item.id} item={item} platform={platform} />
            ))}
          </div>

          {/* Lead quality breakdown */}
          {data.leadQuality.length > 0 && (
            <>
              <Divider />
              <div>
                <div
                  style={{
                    fontSize:     12,
                    color:        C.t3,
                    fontWeight:   600,
                    marginBottom: 4,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  What people are asking
                </div>
                {data.leadQuality.map((item) => (
                  <LeadQualityRow key={item.tag} item={item} />
                ))}
              </div>
            </>
          )}

          {/* Footer link-style line */}
          {data.meta.viewAllLabel && (
            <div style={{ fontSize: 12, color: C.t3, textDecoration: "underline" }}>
              {data.meta.viewAllLabel}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
