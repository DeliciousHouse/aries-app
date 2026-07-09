// ─────────────────────────────────────────────────────────────────────────────
// TopPostsSection.tsx
// Content performance — sortable top posts, expandable rich detail, with a
// pattern callout. API: GET /api/insights/top?period=…&platform=…&sort=…
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
import { C, platformLabel } from "@/frontend/insights/tokens";
import {
  SectionHeader,
  Panel,
  ChannelIcon,
  Icon,
  ErrorState,
  EmptyState,
  LoadingRows,
} from "@/frontend/insights/ui";
// S1-9-PROVISIONAL-DISCLOSURE — REMOVE IN S2-1 (Gap A1 fix).
import { ProvisionalMetricNote } from "@/frontend/insights/ProvisionalMetricNote";

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

const BREAKDOWN_PALETTE = [
  C.accent,
  C.accentB,
  C.green,
  C.amber,
  C.fbBlue,
  C.igPink,
] as const;

// ── A single icon + value stat on the collapsed row ──────────────────────────
function RowStat({ icon, value }: { icon: "eye" | "trend" | "comment"; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
      <Icon name={icon} size={13} color={C.t3} />
      <span
        style={{
          fontSize:           12.5,
          fontWeight:         600,
          color:              C.t1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ── A labelled metric in the expanded strip ──────────────────────────────────
function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10.5, color: C.t3 }}>{label}</span>
      <span
        style={{
          fontSize:           14.5,
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

// ── Sentiment stacked bar + legend ───────────────────────────────────────────
function SentimentBar({ sentiment }: { sentiment: NonNullable<TopPost["sentiment"]> }) {
  const { positive, neutral, negative } = sentiment;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display:      "flex",
          width:        "100%",
          height:       8,
          borderRadius: 99,
          overflow:     "hidden",
          background:   C.track,
        }}
      >
        <div style={{ width: `${positive}%`, background: C.green }} />
        <div style={{ width: `${neutral}%`,  background: C.t3 }} />
        <div style={{ width: `${negative}%`, background: C.red }} />
      </div>
      <div style={{ fontSize: 11, color: C.t3 }}>
        {positive}% positive · {neutral}% neutral · {negative}% negative
      </div>
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
    <div style={{ borderTop: rank > 1 ? `1px solid ${C.border}` : "none" }}>
      <button
        onClick={onToggle}
        style={{
          width:      "100%",
          background: "none",
          border:     "none",
          padding:    "14px 0",
          cursor:     "pointer",
          display:    "flex",
          alignItems: "center",
          gap:        12,
          textAlign:  "left",
        }}
      >
        <span style={{ flexShrink: 0, display: "flex" }}>
          <ChannelIcon platform={post.platform} size={15} />
        </span>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{
              fontSize:     13,
              fontWeight:   500,
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

        <div style={{ display: "flex", gap: 16, flexShrink: 0, alignItems: "center" }}>
          <RowStat icon="eye"     value={post.reach.toLocaleString()} />
          <RowStat icon="trend"   value={`${post.engagement}%`} />
          <RowStat icon="comment" value={post.comments.toLocaleString()} />
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
            padding:      "16px 18px 18px",
            background:   C.surfaceB,
            borderRadius: 10,
            marginBottom: 12,
            border:       `1px solid ${C.borderB}`,
            display:      "flex",
            flexDirection: "column",
            gap:          16,
          }}
        >
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: C.t3, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 }}>
              Performance
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px 12px" }}>
              <MetricCell label="Reach"           value={post.reach.toLocaleString()} />
              <MetricCell label="Engagement rate" value={`${post.engagement}%`} />
              <MetricCell label="Saves"           value={post.saves.toLocaleString()} />
              <MetricCell label="Shares"          value={post.shares.toLocaleString()} />
              <MetricCell label="Comments"        value={post.comments.toLocaleString()} />
              <MetricCell label="Save rate"       value={`${post.saveRate.toFixed(1)}%`} />
            </div>
          </div>

          {post.sentiment && <SentimentBar sentiment={post.sentiment} />}

          {/* Aries narrative — consistent with the Trends "Aries:" card */}
          <div style={{ display: "flex", gap: 9, fontSize: 12.5, lineHeight: 1.55, padding: "11px 13px", background: `${C.accent}10`, border: `1px solid ${C.accent}28`, borderRadius: 10 }}>
            <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="info" size={14} color={C.accentB} /></span>
            <span style={{ color: C.t2 }}><strong style={{ color: C.accentB }}>Aries:</strong> {post.whyItWorked}</span>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {post.permalink && (
              <a
                href={post.permalink}
                target="_blank"
                rel="noreferrer"
                style={{
                  border:         `1px solid ${C.border}`,
                  color:          C.t2,
                  borderRadius:   8,
                  padding:        "6px 12px",
                  fontSize:       12,
                  textDecoration: "none",
                  display:        "inline-flex",
                  alignItems:     "center",
                }}
              >
                Open on {platformLabel[post.platform] ?? post.platform}
              </a>
            )}
            <button
              onClick={() => alert("Ad promotion coming soon")}
              style={{
                background:   C.accent,
                color:        "#fff",
                border:       "none",
                borderRadius: 8,
                padding:      "6px 12px",
                fontSize:     12,
                fontWeight:   600,
                cursor:       "pointer",
              }}
            >
              Promote as ad
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PatternPanel({ pattern }: { pattern: TopData["pattern"] }) {
  const total = pattern.breakdown.reduce((s, b) => s + b.count, 0) || 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style>{`.tp-takeaway .strong{color:${C.t1};font-weight:600;}`}</style>

      {/* Header — spark icon badge + title (matches the mock) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 26, height: 26, borderRadius: 7, background: `${C.accent}1c`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="spark" size={14} color={C.accentB} />
        </span>
        <span style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>Pattern spotted</span>
      </div>

      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.t1 }}>{pattern.title}</div>
        <div style={{ fontSize: 11.5, color: C.t3, marginTop: 3 }}>Top performers, by content type</div>
      </div>

      {pattern.breakdown.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 2, width: "100%", height: 12, borderRadius: 99, overflow: "hidden", background: C.track }}>
            {pattern.breakdown.map((b, i) => (
              <div
                key={b.contentType}
                style={{ width: `${(b.count / total) * 100}%`, background: BREAKDOWN_PALETTE[i % BREAKDOWN_PALETTE.length] }}
              />
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pattern.breakdown.map((b, i) => (
              <div key={b.contentType} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: BREAKDOWN_PALETTE[i % BREAKDOWN_PALETTE.length], flexShrink: 0 }} />
                <span style={{ fontSize: 12.5, color: C.t2, flex: 1 }}>{b.label}</span>
                <span style={{ fontSize: 12, color: C.t3, fontVariantNumeric: "tabular-nums" }}>
                  {b.count} of {total}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Takeaway in its own inset card */}
      <div
        className="tp-takeaway"
        style={{ fontSize: 13, color: C.t2, lineHeight: 1.6, background: C.surfaceB, border: `1px solid ${C.borderB}`, borderRadius: 10, padding: "12px 14px" }}
        dangerouslySetInnerHTML={{ __html: pattern.takeaway }}
      />

      {pattern.note && (
        <div style={{ fontSize: 11, color: C.t3, marginTop: "auto", paddingTop: 4, lineHeight: 1.5 }}>
          {pattern.note}
        </div>
      )}
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

  const empty = !data?.meta?.hasData || !data?.posts?.length;

  return (
    <section>
      {/* Header row: title on the left, sort select on the right */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <SectionHeader title="Top performing content" />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          style={{
            background:   C.surfaceB,
            border:       `1px solid ${C.border}`,
            color:        C.t2,
            borderRadius: 8,
            padding:      "5px 10px",
            fontSize:     12,
            cursor:       "pointer",
            outline:      "none",
            marginBottom: 14,
          }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Sort: {o.label}
            </option>
          ))}
        </select>
      </div>

      <Panel>
        {loading ? (
          <LoadingRows n={5} />
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : empty || !data ? (
          <EmptyState message="No published posts in this period." />
        ) : (
          <>
            <div
              style={{
                display:             "grid",
                gridTemplateColumns: "1.7fr 1fr",
                gap:                 24,
              }}
            >
              {/* LEFT — top 5 posts */}
              <div>
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
                  Your top 5 posts
                </div>
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
                </div>
              </div>

              {/* RIGHT — pattern spotted */}
              <div style={{ borderLeft: `1px solid ${C.border}`, paddingLeft: 20 }}>
                <PatternPanel pattern={data.pattern} />
              </div>
            </div>

            {/* Footer line */}
            <div
              style={{
                marginTop:      18,
                paddingTop:     14,
                borderTop:      `1px solid ${C.border}`,
                fontSize:       12,
                color:          C.t3,
                display:        "flex",
                alignItems:     "center",
                justifyContent: "space-between",
                gap:            12,
                flexWrap:       "wrap",
              }}
            >
              <span>{data.meta.postCount} posts · avg reach {data.meta.avgReach.toLocaleString()}</span>
              {/* S1-9-PROVISIONAL-DISCLOSURE — REMOVE IN S2-1 (Gap A1 fix): reach/
                  saves/shares/comments + avg reach are raw per-post lifetime SUMs
                  (over-count). engagement %, save rate, multiplier are ratios and
                  are NOT affected. */}
              <ProvisionalMetricNote label="Reach / saves / shares / comments are provisional" />
            </div>
          </>
        )}
      </Panel>
    </section>
  );
}
