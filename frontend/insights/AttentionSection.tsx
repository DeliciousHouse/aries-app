// ─────────────────────────────────────────────────────────────────────────────
// AttentionSection.tsx
// Section 3 — Worth your attention: action cards (unreplied, opportunities, …)
// API: GET /api/insights/attention?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform, AttentionData, AttentionCard, AttentionCta } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import { SectionCard, ErrorState, EmptyState, Skeleton } from "@/frontend/insights/ui";

interface AttentionSectionProps {
  period:   Period;
  platform: Platform;
}

function toneColor(tone: AttentionCard["tone"]): string {
  switch (tone) {
    case "urgent":   return C.red;
    case "positive": return C.green;
    case "celebrate": return C.accent;
    case "neutral":
    default:         return C.t3;
  }
}

// ── CTA buttons ────────────────────────────────────────────────────────────────

function PrimaryCta({ cta, tint }: { cta: AttentionCta; tint: string }) {
  const baseStyle = {
    fontSize:       12,
    fontWeight:     600,
    color:          C.t1,
    background:     tint,
    border:         "none",
    borderRadius:   8,
    padding:        "7px 14px",
    cursor:         "pointer",
    textDecoration: "none",
    display:        "inline-block",
  } as const;

  if (cta.href) {
    return (
      <a href={cta.href} style={baseStyle}>
        {cta.label}
      </a>
    );
  }
  return (
    <button
      type="button"
      style={baseStyle}
      onClick={() => {
        if (cta.toast) alert(cta.toast);
      }}
    >
      {cta.label}
    </button>
  );
}

function SecondaryCta({ cta }: { cta: AttentionCta }) {
  const baseStyle = {
    fontSize:       12,
    fontWeight:     500,
    color:          C.t2,
    background:     "transparent",
    border:         `1px solid ${C.borderB}`,
    borderRadius:   8,
    padding:        "7px 14px",
    cursor:         "pointer",
    textDecoration: "none",
    display:        "inline-block",
  } as const;

  if (cta.href) {
    return (
      <a href={cta.href} style={baseStyle}>
        {cta.label}
      </a>
    );
  }
  return (
    <button
      type="button"
      style={baseStyle}
      onClick={() => {
        if (cta.toast) alert(cta.toast);
      }}
    >
      {cta.label}
    </button>
  );
}

function AttentionCardView({ card }: { card: AttentionCard }) {
  const tint = toneColor(card.tone);

  return (
    <div
      style={{
        background:    C.surfaceB,
        border:        `1px solid ${C.borderB}`,
        borderRadius:  12,
        padding:       "16px 18px",
        display:       "flex",
        flexDirection: "column",
        gap:           10,
      }}
    >
      {/* Badge */}
      <span
        style={{
          alignSelf:     "flex-start",
          fontSize:      11,
          fontWeight:    700,
          color:         tint,
          background:    `${tint}1f`,
          borderRadius:  99,
          padding:       "3px 10px",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {card.badge}
      </span>

      {/* Title — may contain <em> tags, styled accent/bold */}
      <div
        className="insights-attention-title"
        style={{ fontSize: 15, fontWeight: 600, color: C.t1, lineHeight: 1.4 }}
        dangerouslySetInnerHTML={{ __html: card.title }}
      />

      {/* Body */}
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: C.t2 }}>
        {card.body}
      </p>

      {/* CTAs */}
      {(card.ctaPrimary || card.ctaSecondary) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 2 }}>
          {card.ctaPrimary && <PrimaryCta cta={card.ctaPrimary} tint={tint} />}
          {card.ctaSecondary && <SecondaryCta cta={card.ctaSecondary} />}
        </div>
      )}
    </div>
  );
}

export function AttentionSection({ period, platform }: AttentionSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<AttentionData>("attention", period, platform);

  return (
    <SectionCard title="Attention" eyebrow="Worth your attention">
      <style>{`
        .insights-attention-title em {
          font-style: normal;
          font-weight: 700;
          color: ${C.accentB};
        }
      `}</style>
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[1, 2, 3].map((n) => <Skeleton key={n} h={120} />)}
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : data?.allCaughtUp || !data?.cards?.length ? (
        <EmptyState message="You're all caught up — nothing needs your attention right now." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {data.cards.map((card, i) => (
            <AttentionCardView key={`${card.type}-${i}`} card={card} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
