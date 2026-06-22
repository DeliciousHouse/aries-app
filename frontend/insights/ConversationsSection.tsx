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
  SectionHeader,
  Panel,
  Pill,
  ErrorState,
  EmptyState,
  LoadingRows,
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

function ConversationRow({
  item,
  platform,
  last,
}: {
  item:     ConversationItem;
  platform: Platform;
  last:     boolean;
}) {
  const bubbleColor = platformColor[platform] ?? C.accent;
  return (
    <div
      style={{
        display:      "flex",
        gap:          12,
        alignItems:   "flex-start",
        padding:      "14px 0",
        borderBottom: last ? "none" : `1px solid ${C.border}`,
      }}
    >
      <div
        style={{
          width:          36,
          height:         36,
          borderRadius:   "50%",
          flexShrink:     0,
          display:        "flex",
          alignItems:     "center",
          justifyContent: "center",
          fontSize:       12,
          fontWeight:     700,
          color:          C.t1,
          background:     `${bubbleColor}2a`,
          border:         `1px solid ${bubbleColor}50`,
        }}
      >
        {item.avatar}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>{item.author}</span>
          <span style={{ fontSize: 11, color: C.t3 }}>{item.timeAgo}</span>
          {item.tagLabel && <Pill label={item.tagLabel} color={tagColor(item.tag)} />}
        </div>
        <div style={{ fontSize: 13, color: C.t2, marginTop: 5, lineHeight: 1.5 }}>
          {item.text}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 8 }}>
          <span style={{ fontSize: 11, color: C.t3 }}>re: {item.postRef}</span>
          <button
            style={{
              background:   "none",
              border:       "none",
              padding:      0,
              cursor:       "pointer",
              fontSize:     11,
              fontWeight:   600,
              color:        C.accentB,
            }}
          >
            Reply
          </button>
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
        display:      "flex",
        alignItems:   "center",
        gap:          12,
        padding:      "10px 0",
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: C.t1, fontWeight: 500 }}>{item.label}</div>
        <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>{item.note}</div>
      </div>
      <span
        style={{
          fontSize:           15,
          fontWeight:         700,
          color:              tagColor(item.tag),
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

  const empty = !data?.conversations?.length;

  return (
    <section>
      <SectionHeader title="Conversations" />
      <Panel>
        {loading ? (
          <LoadingRows n={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : empty || !data ? (
          <EmptyState message="No comments recorded in this period." />
        ) : (
          <div
            style={{
              display:             "grid",
              gridTemplateColumns: "1.6fr 1fr",
              gap:                 24,
            }}
          >
            {/* LEFT — meta row + conversation feed */}
            <div>
              <div
                style={{
                  display:      "flex",
                  alignItems:   "center",
                  gap:          8,
                  flexWrap:     "wrap",
                  fontSize:     12.5,
                  color:        C.t3,
                  paddingBottom: 6,
                }}
              >
                <span>
                  <strong style={{ color: C.t1, fontWeight: 700 }}>{data.meta.total.toLocaleString()}</strong> comments
                </span>
                <span style={{ color: C.border }}>·</span>
                <span style={{ color: data.meta.needsReply > 0 ? C.amber : C.t3 }}>
                  <strong style={{ color: data.meta.needsReply > 0 ? C.amber : C.t1, fontWeight: 700 }}>
                    {data.meta.needsReply.toLocaleString()}
                  </strong>{" "}
                  need a reply
                </span>
                <span style={{ color: C.border }}>·</span>
                <span>
                  <strong style={{ color: C.t1, fontWeight: 700 }}>{data.meta.positivePercent}%</strong> positive
                </span>
              </div>

              <div style={{ display: "flex", flexDirection: "column" }}>
                {data.conversations.map((item, i) => (
                  <ConversationRow
                    key={item.id}
                    item={item}
                    platform={platform}
                    last={i === data.conversations.length - 1}
                  />
                ))}
              </div>
            </div>

            {/* RIGHT — what people are asking */}
            <div style={{ borderLeft: `1px solid ${C.border}`, paddingLeft: 20 }}>
              <div
                style={{
                  fontSize:      10.5,
                  fontWeight:    700,
                  color:         C.t3,
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  marginBottom:  6,
                }}
              >
                What people are asking
              </div>
              {data.leadQuality.map((item) => (
                <LeadQualityRow key={item.tag} item={item} />
              ))}
              {data.meta.viewAllLabel && (
                <div
                  style={{
                    marginTop:      12,
                    fontSize:       12,
                    color:          C.t3,
                    textDecoration: "underline",
                    cursor:         "pointer",
                  }}
                >
                  {data.meta.viewAllLabel}
                </div>
              )}
            </div>
          </div>
        )}
      </Panel>
    </section>
  );
}
