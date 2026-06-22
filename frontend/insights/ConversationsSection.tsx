// ─────────────────────────────────────────────────────────────────────────────
// ConversationsSection.tsx
// Section 7 — Comment engagement + lead detection (uncached endpoint)
// API: GET /api/insights/conversations?period=…&platform=…
//
// Reply / Send to Sequences / View all route to the Conversations workspace,
// which isn't built yet — they surface a "coming soon" toast for now.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Period, Platform, ConversationsData, ConversationItem, LeadQualityItem,
} from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C, platformColor } from "@/frontend/insights/tokens";
import {
  SectionHeader, Panel, ChannelIcon, Icon, ErrorState, EmptyState, LoadingRows,
} from "@/frontend/insights/ui";
import type { IconName } from "@/frontend/insights/ui";

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

function tagIcon(tag: string | null): IconName {
  switch (tag) {
    case "lead":     return "users";
    case "question": return "question";
    case "positive": return "heart";
    default:         return "comment";
  }
}

const comingSoon = () => alert("Opens in the Conversations workspace (coming soon).");

// Compact tag (smaller than the shared Pill).
function MiniTag({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
        color, background: `${color}1c`, border: `1px solid ${color}3a`,
        borderRadius: 99, padding: "1px 6px", whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function ActionButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        background: "transparent", border: `1px solid ${C.border}`, color: C.t2,
        borderRadius: 7, padding: "4px 10px", fontSize: 11.5, fontWeight: 500, cursor: "pointer",
      }}
    >
      <Icon name={icon} size={12} color={C.t2} />
      {label}
    </button>
  );
}

function ConversationRow({ item, last }: { item: ConversationItem; last: boolean }) {
  const bubble = platformColor[item.platform] ?? C.accent;
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "15px 0", borderBottom: last ? "none" : `1px solid ${C.border}` }}>
      <div
        style={{
          width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 700, color: C.t1,
          background: `${bubble}2a`, border: `1px solid ${bubble}50`,
        }}
      >
        {item.avatar}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>{item.author}</span>
          <ChannelIcon platform={item.platform} size={12} />
          <span style={{ fontSize: 11, color: C.t3 }}>{item.timeAgo}</span>
          {item.tagLabel && <MiniTag label={item.tagLabel} color={tagColor(item.tag)} />}
        </div>
        <div style={{ fontSize: 13, color: C.t2, marginTop: 5, lineHeight: 1.5 }}>{item.text}</div>
        <div style={{ fontSize: 11, color: C.t3, marginTop: 6 }}>on “{item.postRef}”</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
          <ActionButton icon="reply" label="Reply" onClick={comingSoon} />
          {item.tag === "lead" && <ActionButton icon="send" label="Send to Sequences" onClick={comingSoon} />}
        </div>
      </div>
    </div>
  );
}

function LeadQualityRow({ item }: { item: LeadQualityItem }) {
  const color = tagColor(item.tag);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
      <span style={{ width: 30, height: 30, borderRadius: 8, background: `${color}1c`, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon name={tagIcon(item.tag)} size={15} color={color} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: C.t1, fontWeight: 500 }}>{item.label}</div>
        <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>{item.note}</div>
      </div>
      <span style={{ fontSize: 18, fontWeight: 700, color: C.t1, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
        {item.count}
      </span>
    </div>
  );
}

export function ConversationsSection({ period, platform }: ConversationsSectionProps) {
  const { data, loading, error, refetch } = useInsight<ConversationsData>("conversations", period, platform);
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
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 24 }}>
            {/* LEFT — meta + feed + view-all */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, paddingBottom: 4 }}>
                <div style={{ fontSize: 12.5, color: C.t3 }}>
                  <strong style={{ color: C.t1, fontWeight: 700 }}>{data.meta.total.toLocaleString()}</strong> comments
                  {" · "}
                  <strong style={{ color: C.green, fontWeight: 700 }}>{data.meta.positivePercent}%</strong> positive
                  {" · "}
                  <strong style={{ color: C.amber, fontWeight: 700 }}>{data.meta.needsReply.toLocaleString()}</strong> need your reply
                </div>
                <span style={{ fontSize: 11, color: C.t3, flexShrink: 0 }}>Sorted by needing your reply</span>
              </div>

              <div style={{ display: "flex", flexDirection: "column" }}>
                {data.conversations.map((item, i) => (
                  <ConversationRow key={item.id} item={item} last={i === data.conversations.length - 1} />
                ))}
              </div>

              {/* View all + channel hint */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                <button
                  onClick={comingSoon}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: C.accentB, padding: 0 }}
                >
                  View all {data.meta.needsReply} replies needed →
                </button>
                <span style={{ fontSize: 11, color: C.t3 }}>Comments and DMs from all channels</span>
              </div>
            </div>

            {/* RIGHT — what people are asking */}
            <div style={{ borderLeft: `1px solid ${C.border}`, paddingLeft: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 26, height: 26, borderRadius: 7, background: `${C.accent}1c`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon name="spark" size={14} color={C.accentB} />
                </span>
                <span style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>What people are asking</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.t3, marginTop: 4, marginBottom: 8 }}>
                Aries classifies each comment so leads don’t slip through
              </div>

              {data.leadQuality.map((item) => (
                <LeadQualityRow key={item.tag} item={item} />
              ))}

              <div style={{ display: "flex", gap: 7, fontSize: 11, color: C.t3, marginTop: 12, lineHeight: 1.5 }}>
                <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="send" size={12} color={C.t3} /></span>
                Lead-tagged comments can be sent to the Sequences CRM with one click.
              </div>
            </div>
          </div>
        )}
      </Panel>
    </section>
  );
}
