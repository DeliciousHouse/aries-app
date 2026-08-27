// ─────────────────────────────────────────────────────────────────────────────
// ConversationsSection.tsx
// Section 7 — Comment engagement + lead detection (uncached endpoint)
// API: GET /api/insights/conversations?period=…&platform=…
//
// Reply posts natively to Meta via POST /api/insights/comments/:id/reply, gated
// on ARIES_NATIVE_REPLY_ENABLED (read server-side in app/insights/page.tsx).
// Send to Sequences / View all still route to the Conversations workspace,
// which isn't built yet — they stay disabled.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";

import type {
  Period, Platform, ConversationsData, ConversationItem, LeadQualityItem,
} from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
// AA-129 item 10 (qa-defect #648): the capability matrix already knows which
// platforms can serve comments at all. Reading it here means the empty state
// explains itself instead of implying the tenant simply has no comments.
import { platformSupports } from "@/backend/insights/platforms/capabilities";
import { PLATFORM_LABELS } from "@/backend/insights/platforms/registry";
import { C, platformColor } from "@/frontend/insights/tokens";
import {
  SectionHeader, Panel, ChannelIcon, Icon, ErrorState, EmptyState, LoadingRows,
} from "@/frontend/insights/ui";
import type { IconName } from "@/frontend/insights/ui";

interface ConversationsSectionProps {
  period:   Period;
  platform: Platform;
  /** Mirrors ARIES_NATIVE_REPLY_ENABLED, read server-side in app/insights/page.tsx.
   *  When off the reply endpoint returns a real 404, so the control stays disabled
   *  rather than offering an action that cannot succeed. */
  nativeReplyEnabled?: boolean;
  /** AA-123: false while the section is below the fold — defers the
   *  FETCH only; the section's markup always renders. */
  enabled?: boolean;
}

/** Matches MAX_REPLY_LENGTH in the reply handler. Enforced here too so the
 *  operator sees the limit while typing instead of after a round trip. */
const MAX_REPLY_LENGTH = 8000;

type ReplyOutcome = { kind: 'replied' } | { kind: 'error'; message: string };

/** Maps the reply endpoint's response onto operator-facing copy. The endpoint
 *  never returns the raw Graph error, so these are the only cases to handle. */
function describeReplyFailure(status: number, reason: string | null): string {
  if (status === 404) {
    return reason === 'not_found'
      ? 'This comment is no longer available, or replying is not enabled.'
      : 'Reply is unavailable.';
  }
  if (reason === 'missing_reply_text') return 'Write a reply first.';
  if (reason === 'reply_text_too_long') return `Replies are limited to ${MAX_REPLY_LENGTH} characters.`;
  if (reason === 'unsupported_platform') return 'Replies are not supported for this platform.';
  if (reason === 'needs_manual_reconciliation') {
    // The publish path could not confirm the outcome. Never auto-retry: the
    // reply may already be live.
    return 'The reply may have posted but could not be confirmed. Check the post before retrying.';
  }
  return 'Reply failed. Try again in a moment.';
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

function ActionButton({
  icon, label, onClick, disabled, title,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        background: "transparent", border: `1px solid ${C.border}`, color: C.t2,
        borderRadius: 7, padding: "4px 10px", fontSize: 11.5, fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon name={icon} size={12} color={C.t2} />
      {label}
    </button>
  );
}

function ConversationRow({
  item, last, nativeReplyEnabled,
}: { item: ConversationItem; last: boolean; nativeReplyEnabled: boolean }) {
  const bubble = platformColor[item.platform] ?? C.accent;
  const [composerOpen, setComposerOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<ReplyOutcome | null>(null);

  // `handled` is is_replied on the stored comment, so a comment replied to in a
  // previous session shows as replied without needing a local send.
  const alreadyReplied = item.handled || outcome?.kind === 'replied';
  const trimmed = replyText.trim();
  const tooLong = trimmed.length > MAX_REPLY_LENGTH;
  const canSend = !sending && trimmed.length > 0 && !tooLong;

  async function sendReply() {
    if (!canSend) return;
    setSending(true);
    setOutcome(null);
    try {
      const res = await fetch(`/api/insights/comments/${item.id}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reply_text: trimmed }),
      });
      const body = (await res.json().catch(() => null)) as
        | { status?: string; reason?: string }
        | null;

      // `already_replied` is a 200 and means the reply is live — treat it as
      // success so a double-submit converges instead of showing an error.
      if (res.ok && (body?.status === 'replied' || body?.status === 'already_replied')) {
        setOutcome({ kind: 'replied' });
        setComposerOpen(false);
        setReplyText('');
        return;
      }
      setOutcome({ kind: 'error', message: describeReplyFailure(res.status, body?.reason ?? null) });
    } catch {
      setOutcome({ kind: 'error', message: 'Network error — the reply was not sent.' });
    } finally {
      setSending(false);
    }
  }
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
          {alreadyReplied ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: C.green }}>
              <Icon name="reply" size={12} color={C.green} />
              Replied
            </span>
          ) : (
            <ActionButton
              icon="reply"
              label="Reply"
              disabled={!nativeReplyEnabled}
              title={nativeReplyEnabled ? "Reply to this comment" : "Reply ships soon"}
              onClick={() => setComposerOpen((open) => !open)}
            />
          )}
          {item.tag === "lead" && (
            <ActionButton icon="send" label="Send to Sequences" disabled title="Coming soon" />
          )}
        </div>

        {composerOpen && !alreadyReplied && (
          <div style={{ marginTop: 9 }}>
            <textarea
              value={replyText}
              onChange={(event) => setReplyText(event.target.value)}
              placeholder={`Reply to ${item.author}…`}
              rows={3}
              aria-label={`Reply to ${item.author}`}
              style={{
                width: "100%", background: "transparent", color: C.t1,
                border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "8px 10px", fontSize: 13, lineHeight: 1.5, resize: "vertical",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
              <ActionButton
                icon="send"
                label={sending ? "Sending…" : "Send reply"}
                disabled={!canSend}
                onClick={sendReply}
              />
              {/* Plain text button — the shared icon set has no cancel glyph. */}
              <button
                type="button"
                disabled={sending}
                onClick={() => { setComposerOpen(false); setOutcome(null); }}
                style={{
                  background: "transparent", border: "none", color: C.t3,
                  fontSize: 11.5, fontWeight: 500, padding: "4px 2px",
                  cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.5 : 1,
                }}
              >
                Cancel
              </button>
              {tooLong && (
                <span style={{ fontSize: 11, color: C.t3 }}>
                  {trimmed.length.toLocaleString()} / {MAX_REPLY_LENGTH.toLocaleString()}
                </span>
              )}
            </div>
          </div>
        )}

        {outcome?.kind === "error" && (
          <div role="alert" style={{ fontSize: 11.5, color: C.t3, marginTop: 7 }}>
            {outcome.message}
          </div>
        )}
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

/**
 * AA-129 item 10 / qa-defect #648 — why a platform can show no comments.
 *
 * LinkedIn is the live case: Composio exposes NO list-comments action for it,
 * so the adapter ingests nothing and this section can only ever be empty for a
 * LinkedIn-filtered view. "No comments recorded in this period" is then a
 * misleading answer — it reads as "nobody commented", when the truth is "we
 * cannot see LinkedIn comments at all". An operator chasing that difference
 * files a bug against working software.
 *
 * Driven off the capability matrix rather than a hardcoded platform check, so a
 * platform that gains (or loses) comment support carries the right copy with no
 * change here. 'all' keeps the generic message: other channels' comments are
 * genuinely included, so an absence there really does mean no comments.
 */
function emptyCommentsMessage(platform: Platform): string {
  if (platform === "all" || platformSupports(platform, "comments")) {
    return "No comments recorded in this period.";
  }
  const label = PLATFORM_LABELS[platform];
  return `${label} comments aren't available to Aries yet — the platform doesn't expose them, so this list can't include them. Comments from your other channels still appear here.`;
}

export function ConversationsSection({ period, platform, enabled, nativeReplyEnabled = false }: ConversationsSectionProps) {
  const { data, loading, error, refetch } = useInsight<ConversationsData>("conversations", period, platform, {}, { enabled });
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
          <EmptyState message={emptyCommentsMessage(platform)} />
        ) : (
          <div className="insights-grid" style={{ "--insights-cols": "1.6fr 1fr", gap: 24 } as React.CSSProperties}>
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
                  <ConversationRow
                    key={item.id}
                    item={item}
                    last={i === data.conversations.length - 1}
                    nativeReplyEnabled={nativeReplyEnabled}
                  />
                ))}
              </div>

              {/* View all + channel hint */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                <button
                  disabled
                  title="Coming soon"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "not-allowed", opacity: 0.5, fontSize: 12.5, fontWeight: 600, color: C.accentB, padding: 0 }}
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
