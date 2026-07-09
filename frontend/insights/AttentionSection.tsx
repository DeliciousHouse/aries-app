// ─────────────────────────────────────────────────────────────────────────────
// AttentionSection.tsx
// Section 3 — Worth your attention: action cards (unreplied, opportunities, …)
// API: GET /api/insights/attention?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform, AttentionData, AttentionCard, AttentionCta } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import { SectionHeader, Panel, Pill, ErrorState, EmptyState, LoadingRows } from "@/frontend/insights/ui";

interface AttentionSectionProps {
  period:   Period;
  platform: Platform;
}

function toneColor(tone: AttentionCard["tone"]): string {
  switch (tone) {
    case "urgent":    return C.amber;
    case "positive":  return C.green;
    case "celebrate": return C.accent;
    case "neutral":
    default:          return C.t3;
  }
}

// Icon shown INSIDE the badge pill, chosen by card type.
function badgeIcon(type: AttentionCard["type"]): string {
  switch (type) {
    case "unreplied":   return "comment";   // messaging icon
    case "opportunity": return "trend";     // upward zigzag
    case "pattern":     return "spark";
    case "milestone":   return "award";
    case "calibrating":
    default:            return "info";
  }
}

// ── CTA buttons ────────────────────────────────────────────────────────────────

function PrimaryCta({ cta }: { cta: AttentionCta }) {
  const baseStyle = {
    fontSize:       12,
    fontWeight:     600,
    color:          "#fff",
    background:     C.accent,
    border:         "none",
    borderRadius:   8,
    padding:        "6px 12px",
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
  // No real destination yet — show it disabled (planned, not broken) rather
  // than firing a placeholder popup. S5-* wires these for real.
  return (
    <button type="button" disabled title="Coming soon" style={{ ...baseStyle, opacity: 0.5, cursor: "not-allowed" }}>
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
    border:         `1px solid ${C.border}`,
    borderRadius:   8,
    padding:        "6px 12px",
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
  // No real destination yet — disabled (planned, not broken), no placeholder popup.
  return (
    <button type="button" disabled title="Coming soon" style={{ ...baseStyle, opacity: 0.5, cursor: "not-allowed" }}>
      {cta.label}
    </button>
  );
}

function AttentionCardView({ card }: { card: AttentionCard }) {
  const tint = toneColor(card.tone);

  // "View details" on the opportunity card points at the Top Performing Content
  // section, which is rendered on this same page — so wire it as an in-page
  // anchor rather than a placeholder. Keyed on card.type (structural), so no
  // cached-builder change and no TEMPLATE_VERSION bump. Other no-href CTAs (e.g.
  // "Mark as read") have no real target yet and fall through to disabled.
  const secondaryCta =
    card.ctaSecondary && !card.ctaSecondary.href && card.type === "opportunity"
      ? { ...card.ctaSecondary, href: "#top-performing" }
      : card.ctaSecondary;

  return (
    <div
      style={{
        position:      "relative",
        background:    C.surfaceB,
        border:        `1px solid ${C.borderB}`,
        borderRadius:  12,
        padding:       16,
        paddingLeft:   18,
        display:       "flex",
        flexDirection: "column",
      }}
    >
      {/* Short accent marker — a few px at the top-left, not the whole side */}
      <span
        style={{
          position:     "absolute",
          top:          14,
          left:         0,
          width:        3,
          height:       20,
          borderRadius: 99,
          background:   tint,
        }}
      />

      {/* Badge pill — icon sits INSIDE the pill with the label */}
      <div style={{ alignSelf: "flex-start" }}>
        <Pill label={card.badge} color={tint} icon={badgeIcon(card.type)} />
      </div>

      {/* Title — may contain <em> tags, styled normal/bold */}
      <div
        className="insights-attention-title"
        style={{ fontSize: 14.5, fontWeight: 500, color: C.t1, lineHeight: 1.4, marginTop: 10 }}
        dangerouslySetInnerHTML={{ __html: card.title }}
      />

      {/* Body */}
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: C.t2, marginTop: 6 }}>
        {card.body}
      </p>

      {/* CTAs */}
      {(card.ctaPrimary || card.ctaSecondary) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {card.ctaPrimary && <PrimaryCta cta={card.ctaPrimary} />}
          {secondaryCta && <SecondaryCta cta={secondaryCta} />}
        </div>
      )}
    </div>
  );
}

export function AttentionSection({ period, platform }: AttentionSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<AttentionData>("attention", period, platform);

  const cardCount = data?.cards?.length ?? 0;

  return (
    <section>
      <SectionHeader
        title="Worth your attention"
        note={cardCount ? `${cardCount} things worth your time` : undefined}
      />
      <Panel>
        <style>{`
          .insights-attention-title em {
            font-style: normal;
            font-weight: 700;
            color: ${C.t1};
          }
        `}</style>
        {loading ? (
          <LoadingRows n={3} />
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : !data || data.allCaughtUp || !data.cards?.length ? (
          <EmptyState message="You're all caught up — nothing needs your attention right now." />
        ) : (
          <div
            style={{
              display:             "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
              gap:                 14,
            }}
          >
            {data.cards.map((card, i) => (
              <AttentionCardView key={`${card.type}-${i}`} card={card} />
            ))}
          </div>
        )}
      </Panel>
    </section>
  );
}
