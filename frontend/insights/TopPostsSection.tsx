// ─────────────────────────────────────────────────────────────────────────────
// TopPostsSection.tsx
// Content performance — sortable top posts, expandable, with pattern callout
// API: GET /api/insights/top?period=…&platform=…&sort=…
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import type {
  Period,
  Platform,
  TopData,
  TopPost,
  SortKey,
} from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import {
  SectionCard,
  PlatformDot,
  ErrorState,
  EmptyState,
  LoadingRows,
} from "@/frontend/insights/ui";

interface TopPostsSectionProps {
  period:   Period;
  platform: Platform;
}

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "reach",      label: "Reach" },
  { value: "engagement", label: "Engagement" },
  { value: "saves",      label: "Saves" },
  { value: "shares",     label: "Shares" },
  { value: "comments",   label: "Comments" },
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div
        style={{
          fontSize:           12,
          fontWeight:         600,
          color:              C.t1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 10, color: C.t3 }}>{label}</div>
    </div>
  );
}

function PostRow({
  post,
  rank,
  expanded,
  onToggle,
}: {
  post:     TopPost;
  rank:     number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <button
        onClick={onToggle}
        style={{
          width:      "100%",
          background: "none",
          border:     "none",
          borderTop:  rank > 1 ? `1px solid ${C.border}` : "none",
          padding:    "14px 0",
          cursor:     "pointer",
          display:    "flex",
          alignItems: "center",
          gap:        12,
          textAlign:  "left",
        }}
      >
        <PlatformDot platform={post.platform} />

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{
              fontSize:     13,
              color:        C.t1,
              overflow:     "hidden",
              textOverflow: "ellipsis",
              whiteSpace:   "nowrap",
            }}
          >
            {post.title ?? "Untitled"}
          </span>
          <span style={{ fontSize: 11, color: C.t3 }}>{post.dateLabel}</span>
        </div>

        <div style={{ display: "flex", gap: 20, flexShrink: 0 }}>
          <Stat label="Reach"      value={post.reach.toLocaleString()} />
          <Stat label="Eng%"       value={`${post.engagement}%`} />
          <Stat label="Saves"      value={post.saves.toLocaleString()} />
          <Stat label="Multiplier" value={`${post.multiplier}x`} />
        </div>

        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke={C.t3}
          strokeWidth="2"
          width={14}
          height={14}
          style={{
            transform:  expanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s",
            flexShrink: 0,
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div
          style={{
            padding:      "12px 16px 16px",
            background:   C.surfaceB,
            borderRadius: 10,
            marginBottom: 8,
            border:       `1px solid ${C.borderB}`,
          }}
        >
          <div
            style={{
              fontSize:      11,
              color:         C.accentB,
              fontWeight:    600,
              marginBottom:  8,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Why it worked
          </div>
          <p
            style={{
              margin:       0,
              marginBottom: 14,
              fontSize:     13,
              color:        C.t2,
              lineHeight:   1.65,
            }}
          >
            {post.whyItWorked}
          </p>

          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <Stat2 label="Shares"    value={post.shares.toLocaleString()} />
            <Stat2 label="Comments"  value={post.comments.toLocaleString()} />
            <Stat2 label="Save rate" value={`${post.saveRate}%`} />
          </div>

          {post.sentiment && (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: C.t3 }}>Sentiment</span>
              <div style={{ display: "flex", gap: 16 }}>
                <span style={{ fontSize: 12, color: C.green }}>
                  Positive {post.sentiment.positive}%
                </span>
                <span style={{ fontSize: 12, color: C.t2 }}>
                  Neutral {post.sentiment.neutral}%
                </span>
                <span style={{ fontSize: 12, color: C.red }}>
                  Negative {post.sentiment.negative}%
                </span>
              </div>
            </div>
          )}

          {post.followerSplit && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: C.t3 }}>Follower split</span>
              <span style={{ fontSize: 13, color: C.t2 }}>{post.followerSplit}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Stat2({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, color: C.t3 }}>{label}</span>
      <span
        style={{
          fontSize:           15,
          fontWeight:         700,
          color:              C.t1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function TopPostsSection({ period, platform }: TopPostsSectionProps) {
  const [sort, setSort]         = useState<SortKey>("reach");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const { data, loading, error, refetch } =
    useInsight<TopData>("top", period, platform, { sort });

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <SectionCard
      title="Top Posts"
      eyebrow="Content performance"
      action={
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          style={{
            background:   C.surfaceB,
            border:       `1px solid ${C.border}`,
            color:        C.t2,
            borderRadius: 8,
            padding:      "6px 10px",
            fontSize:     12,
            cursor:       "pointer",
            outline:      "none",
          }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Sort: {o.label}
            </option>
          ))}
        </select>
      }
    >
      {loading ? (
        <LoadingRows n={5} />
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : !data?.meta?.hasData || !data?.posts?.length ? (
        <EmptyState message="No posts published in this period." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {data.posts.map((post, i) => (
            <PostRow
              key={post.id}
              post={post}
              rank={i + 1}
              expanded={expanded.has(post.id)}
              onToggle={() => toggleExpand(post.id)}
            />
          ))}

          {/* Pattern callout */}
          <div
            style={{
              marginTop:    14,
              padding:      "14px 16px",
              background:   `${C.accent}10`,
              border:       `1px solid ${C.accent}28`,
              borderRadius: 10,
              display:      "flex",
              flexDirection: "column",
              gap:          8,
            }}
          >
            <div
              style={{
                fontSize:      11,
                color:         C.accentB,
                fontWeight:    600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {data.pattern.title}
            </div>
            <div
              style={{ fontSize: 13, color: C.t2, lineHeight: 1.6 }}
              dangerouslySetInnerHTML={{ __html: data.pattern.takeaway }}
            />
            {data.pattern.note && (
              <div style={{ fontSize: 12, color: C.t3 }}>{data.pattern.note}</div>
            )}
            {data.pattern.breakdown.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {data.pattern.breakdown.map((b) => (
                  <span
                    key={b.contentType}
                    style={{
                      fontSize:     11,
                      color:        C.t2,
                      padding:      "4px 10px",
                      borderRadius: 99,
                      background:   C.surfaceB,
                      border:       `1px solid ${C.borderB}`,
                    }}
                  >
                    {b.label}{" "}
                    <span style={{ color: C.t1, fontWeight: 600 }}>×{b.count}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Footer line */}
          <div
            style={{
              marginTop:  12,
              paddingTop: 10,
              borderTop:  `1px solid ${C.border}`,
              fontSize:   12,
              color:      C.t3,
            }}
          >
            {data.meta.postCount} posts · avg reach {data.meta.avgReach.toLocaleString()}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
