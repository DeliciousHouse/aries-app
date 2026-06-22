// ─────────────────────────────────────────────────────────────────────────────
// HeroSection.tsx
// Section 1 — Full-width hero band: narrative summary + Aries Score ring
// API: GET /api/insights/narrative?period=…&platform=…
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform, NarrativeData } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C, platformLabel } from "@/frontend/insights/tokens";
import { Skeleton, ErrorState, EmptyState, DeltaBadge } from "@/frontend/insights/ui";

interface HeroSectionProps {
  period:   Period;
  platform: Platform;
}

const PERIOD_LABEL: Record<Period, string> = {
  week:    "This week",
  "30day": "Last 30 days",
  "90day": "Last 90 days",
};

// ── Aries Score ring (SVG) — fill fraction = score / 100 ────────────────────────

function ScoreRing({ score }: { score: number }) {
  const r            = 58;
  const circumference = 2 * Math.PI * r;
  const fraction      = Math.max(0, Math.min(1, score / 100));
  const dashOffset    = circumference * (1 - fraction);

  return (
    <div style={{ position: "relative", width: 120, height: 120 }}>
      <svg
        viewBox="0 0 132 132"
        style={{ transform: "rotate(-90deg)", width: "100%", height: "100%" }}
      >
        <defs>
          <linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stopColor={C.accent} />
            <stop offset="100%" stopColor={C.accentB} />
          </linearGradient>
        </defs>
        <circle cx="66" cy="66" r={r} fill="none" stroke={C.border} strokeWidth="10" />
        <circle
          cx="66" cy="66" r={r}
          fill="none"
          stroke="url(#scoreGradient)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(0.34,1.56,0.64,1)" }}
        />
      </svg>
      <div
        style={{
          position:       "absolute",
          inset:          0,
          display:        "flex",
          flexDirection:  "column",
          alignItems:     "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            fontSize:           28,
            fontWeight:         800,
            color:              C.t1,
            lineHeight:         1,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {Math.round(score)}
        </span>
        <span style={{ fontSize: 10, color: C.t3 }}>/ 100</span>
      </div>
    </div>
  );
}

export function HeroSection({ period, platform }: HeroSectionProps) {
  const { data, loading, error, refetch } =
    useInsight<NarrativeData>("narrative", period, platform);

  // Eyebrow + cached pill always render; body switches on state.
  return (
    <section
      style={{
        position:     "relative",
        background:   `linear-gradient(135deg, #1a0e2e 0%, ${C.surface} 60%)`,
        border:       `1px solid ${C.border}`,
        borderRadius: 20,
        padding:      "32px 36px",
        overflow:     "hidden",
      }}
    >
      {/* Eyebrow */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
        <span
          style={{
            width:        8,
            height:       8,
            borderRadius: "50%",
            background:   C.accent,
            boxShadow:    `0 0 8px ${C.accent}`,
            display:      "inline-block",
          }}
        />
        <span style={{ fontSize: 12, color: C.t3, fontWeight: 500 }}>
          {PERIOD_LABEL[period]}
        </span>
        {data?.cached && (
          <span
            style={{
              fontSize:     10,
              color:        C.t3,
              background:   C.surfaceB,
              border:       `1px solid ${C.border}`,
              borderRadius: 99,
              padding:      "1px 7px",
            }}
          >
            cached
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Skeleton h={20} w="90%" />
          <Skeleton h={20} w="75%" />
          <Skeleton h={20} w="55%" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : data?.status === "not_connected" ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <EmptyState message={`Connect ${platformLabel[platform] ?? platform} to see your summary.`} />
          {data.connect_url && (
            <a
              href={data.connect_url}
              style={{
                fontSize:       13,
                fontWeight:     600,
                color:          C.t1,
                background:     C.accent,
                borderRadius:   8,
                padding:        "8px 16px",
                textDecoration: "none",
              }}
            >
              Connect {platformLabel[platform] ?? platform}
            </a>
          )}
        </div>
      ) : !data?.snapshot?.hasData ? (
        <EmptyState message="Not enough data yet — publish some posts to see your summary." />
      ) : (
        <div
          style={{
            display:             "grid",
            gridTemplateColumns: "1fr auto",
            gap:                 32,
            alignItems:          "center",
          }}
        >
          {/* ── Left: narrative + meta + snapshot stats ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
            <p
              style={{
                margin:     0,
                fontSize:   17,
                lineHeight: 1.6,
                fontWeight: 500,
                color:      C.t1,
                maxWidth:   600,
              }}
            >
              {data.narrative}
            </p>

            {/* Period meta line */}
            <div
              style={{
                fontSize: 13,
                color:    C.t2,
                display:  "flex",
                flexWrap: "wrap",
                gap:      "4px 14px",
                alignItems: "center",
              }}
            >
              <span>
                <strong style={{ color: C.t1 }}>{data.periodMeta.posts}</strong>{" "}
                {data.periodMeta.postsLabel}
              </span>
              <span style={{ color: C.t3 }}>·</span>
              <span>
                <strong style={{ color: C.t1 }}>{data.periodMeta.comments.toLocaleString()}</strong>{" "}
                comments
              </span>
              <span style={{ color: C.t3 }}>·</span>
              <span>
                <strong style={{ color: C.t1 }}>{data.periodMeta.hoursSaved.toFixed(1)}</strong>{" "}
                hours saved
              </span>
            </div>

            {/* Snapshot stat tiles */}
            <div
              style={{
                display:             "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap:                 12,
              }}
            >
              <SnapshotStat
                label={data.snapshot.reachLabel}
                value={data.snapshot.reach.toLocaleString()}
                delta={data.snapshot.reachDelta}
              />
              <SnapshotStat
                label="Engagement rate"
                value={`${data.snapshot.engagementRate.toFixed(1)}%`}
              />
              <SnapshotStat
                label="Unreplied"
                value={data.snapshot.unreplied.toLocaleString()}
              />
            </div>
          </div>

          {/* ── Right: Aries Score ring ── */}
          <aside
            style={{
              display:       "flex",
              flexDirection: "column",
              alignItems:    "center",
              gap:           8,
              minWidth:      140,
            }}
          >
            <div
              style={{
                fontSize:      11,
                color:         C.t3,
                fontWeight:    600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Aries Score
            </div>
            <ScoreRing score={data.score} />
            <div style={{ fontSize: 13, fontWeight: 600, color: C.accentB }}>
              {data.judgment}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.t3 }}>
              <DeltaBadge delta={data.scoreDelta} />
              <span>vs prev</span>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

// ── Snapshot stat (compact tile) ────────────────────────────────────────────────

function SnapshotStat({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: number;
}) {
  return (
    <div
      style={{
        background:    C.surfaceB,
        border:        `1px solid ${C.borderB}`,
        borderRadius:  10,
        padding:       "12px 14px",
        display:       "flex",
        flexDirection: "column",
        gap:           6,
      }}
    >
      <div style={{ fontSize: 11, color: C.t3, fontWeight: 500 }}>{label}</div>
      <div
        style={{
          fontSize:           20,
          fontWeight:         700,
          color:              C.t1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {delta !== undefined && <DeltaBadge delta={delta} />}
    </div>
  );
}
