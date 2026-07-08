// ─────────────────────────────────────────────────────────────────────────────
// ui.tsx — Shared primitive components used across all Insights sections
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode, CSSProperties } from "react";
import { C, platformColor } from "@/frontend/insights/tokens";

// ── Section header (sits OUTSIDE the card, above it) ─────────────────────────
// eyebrow = small uppercase label, title = section name, note = right-aligned hint

export function SectionHeader({
  title,
  note,
  eyebrow: _eyebrow,
}: {
  title:    string;
  note?:    string;
  /** @deprecated single-line header now — pass the full label as `title`. */
  eyebrow?: string;
}) {
  return (
    <div
      style={{
        display:        "flex",
        alignItems:     "baseline",
        justifyContent: "space-between",
        gap:            16,
        marginBottom:   14,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 15.5, fontWeight: 600, color: C.t1, letterSpacing: "-0.01em" }}>
        {title}
      </h2>
      {note && (
        <span style={{ fontSize: 11.5, color: C.t3, textAlign: "right", maxWidth: 340 }}>{note}</span>
      )}
    </div>
  );
}

// ── Icon set (stroke, currentColor) ──────────────────────────────────────────
// Used across sections for reach (eye), engagement (trend), comments, etc.

export type IconName =
  | "eye" | "trend" | "comment" | "clock" | "post" | "spark"
  | "arrow-up" | "bell" | "award" | "info" | "users" | "calendar"
  | "heart" | "reply" | "send" | "question";

// Map the backend's card.icon strings onto our set.
const ICON_ALIAS: Record<string, IconName> = {
  "message-circle": "comment", "message-square": "comment",
  "trending-up": "arrow-up", "activity": "trend",
  "sparkles": "spark", "award": "award", "info": "info",
  "user-plus": "arrow-up", "user-check": "eye", "eye": "eye",
};

export function Icon({
  name,
  size = 15,
  color = "currentColor",
  strokeWidth = 1.7,
}: {
  name: IconName | string;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const n = (ICON_ALIAS[name] ?? name) as IconName;
  const common = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: color, strokeWidth, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (n) {
    case "eye":
      return (<svg {...common}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>);
    case "trend":
      return (<svg {...common}><path d="M3 17l5-5 4 3 8-8" /><path d="M16 7h5v5" /></svg>);
    case "comment":
      return (<svg {...common}><path d="M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 21l2-5.5A8.5 8.5 0 1 1 21 11.5Z" /></svg>);
    case "clock":
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
    case "post":
      return (<svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v5" /></svg>);
    case "spark":
      return (<svg {...common}><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z" /></svg>);
    case "arrow-up":
      return (<svg {...common}><path d="M5 15l7-7 7 7" /></svg>);
    case "bell":
      return (<svg {...common}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>);
    case "award":
      return (<svg {...common}><circle cx="12" cy="9" r="5" /><path d="M9 13.5 8 22l4-2 4 2-1-8.5" /></svg>);
    case "users":
      return (<svg {...common}><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5.5a3 3 0 0 1 0 5.8M22 20a6 6 0 0 0-4-5.6" /></svg>);
    case "calendar":
      return (<svg {...common}><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>);
    case "heart":
      return (<svg {...common}><path d="M12 20s-7-4.4-9.3-8.8C1.2 7.7 3.1 4.7 6.3 4.7c1.9 0 3 1.1 3.7 2.1.7-1 1.8-2.1 3.7-2.1 3.2 0 5.1 3 3.6 6.5C19 15.6 12 20 12 20Z" /></svg>);
    case "reply":
      return (<svg {...common}><path d="M9 7 4 12l5 5" /><path d="M4 12h11a5 5 0 0 1 5 5v1" /></svg>);
    case "send":
      return (<svg {...common}><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7Z" /></svg>);
    case "question":
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M9.2 9.3a2.8 2.8 0 0 1 5.4 1c0 1.9-2.6 2.2-2.6 4M12 17h.01" /></svg>);
    case "info":
    default:
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>);
  }
}

// ── Pill badge (NEEDS REPLY / OPPORTUNITY / PATTERN …) ───────────────────────

export function Pill({
  label,
  color = C.t3,
  icon,
}: {
  label: string;
  color?: string;
  icon?: IconName | string;
}) {
  return (
    <span
      style={{
        display:       "inline-flex",
        alignItems:    "center",
        gap:           5,
        fontSize:      10,
        fontWeight:    700,
        letterSpacing: "0.07em",
        textTransform: "uppercase",
        color,
        background:    `${color}1c`,
        border:        `1px solid ${color}3a`,
        borderRadius:  99,
        padding:       "3px 9px",
      }}
    >
      {icon && <Icon name={icon} size={11} color={color} strokeWidth={2} />}
      {label}
    </span>
  );
}

// ── Brand channel icon (16px) ────────────────────────────────────────────────

export function ChannelIcon({ platform, size = 15 }: { platform: string; size?: number }) {
  const s = size;
  switch (platform) {
    case "instagram":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke={C.igPink} strokeWidth="2" />
          <circle cx="12" cy="12" r="4.2" stroke={C.igPink} strokeWidth="2" />
          <circle cx="17.4" cy="6.6" r="1.3" fill={C.igPink} />
        </svg>
      );
    case "facebook":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="11" fill={C.fbBlue} />
          <path d="M13.5 12h2l.4-2.6h-2.4V7.7c0-.75.25-1.26 1.33-1.26H16V4.1A18 18 0 0 0 13.9 4c-2.07 0-3.5 1.27-3.5 3.6v2.0H8.2V12h2.2v6.9h3.1V12Z" fill="#fff" />
        </svg>
      );
    case "linkedin":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <rect width="24" height="24" rx="4" fill={C.liBlue} />
          <path d="M7.1 9.4H4.6V19h2.5V9.4ZM5.85 8.3a1.45 1.45 0 1 0 0-2.9 1.45 1.45 0 0 0 0 2.9ZM19.4 19v-5.3c0-2.6-1.4-3.8-3.25-3.8-1.5 0-2.17.82-2.54 1.4V9.4H11.1c.03.7 0 9.6 0 9.6h2.5v-5.36c0-.23.02-.46.09-.62.18-.45.6-.92 1.3-.92.92 0 1.3.7 1.3 1.73V19h2.6Z" fill="#fff" />
        </svg>
      );
    case "x":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M17.5 3h2.9l-6.36 7.27L21.5 21h-5.86l-4.58-6-5.24 6H2.9l6.8-7.78L2.5 3h6l4.14 5.47L17.5 3Zm-1.02 16.2h1.6L7.6 4.72H5.9l10.58 14.48Z" fill={C.xText} />
        </svg>
      );
    case "youtube":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <rect x="1.5" y="5" width="21" height="14" rx="4" fill={C.ytRed} />
          <path d="M10 8.6 15.2 12 10 15.4V8.6Z" fill="#fff" />
        </svg>
      );
    case "tiktok":
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M16.5 3c.3 2.1 1.5 3.4 3.5 3.6v2.5c-1.2.1-2.4-.2-3.5-.8v5.6c0 3.2-2.4 5.5-5.4 5.5-3 0-5.1-2.4-5.1-5 0-2.8 2.3-4.9 5.2-4.7v2.6c-.4-.1-.9-.2-1.3-.1-1.2.2-2.1 1.1-2 2.4.1 1.2 1 2.1 2.2 2.1 1.3 0 2.2-1 2.2-2.4V3h3.7Z" fill={C.t1} />
        </svg>
      );
    default: // all
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          {[5, 13].map((x) =>
            [5, 13].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="6" height="6" rx="1.6" fill={C.accent} />),
          )}
        </svg>
      );
  }
}

// ── Aries Score dial (ring + judgment + delta) ───────────────────────────────

export function ScoreDial({
  score,
  judgment,
  scoreDelta,
}: {
  score:      number;
  judgment:   string;
  scoreDelta: number;
}) {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, score / 100));
  const up = scoreDelta >= 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <div
        style={{
          fontSize: 10.5, fontWeight: 700, color: C.t3,
          textTransform: "uppercase", letterSpacing: "0.09em",
        }}
      >
        Aries Score
      </div>
      <div style={{ position: "relative", width: 132, height: 132 }}>
        <svg viewBox="0 0 132 132" style={{ transform: "rotate(-90deg)", width: "100%", height: "100%" }}>
          <defs>
            <linearGradient id="scoreDial" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={C.accentB} />
              <stop offset="100%" stopColor={C.accent} />
            </linearGradient>
          </defs>
          <circle cx="66" cy="66" r={r} fill="none" stroke={C.track} strokeWidth="9" />
          <circle
            cx="66" cy="66" r={r} fill="none" stroke="url(#scoreDial)" strokeWidth="9"
            strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - frac)}
            style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(0.34,1.56,0.64,1)" }}
          />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 34, fontWeight: 800, color: C.t1, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
            {Math.round(score)}
          </span>
          <span style={{ fontSize: 10, color: C.t3 }}>/ 100</span>
        </div>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.accentB }}>{judgment}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
        <span style={{ color: up ? C.green : C.red, fontWeight: 600 }}>
          {up ? "▲" : "▼"} {Math.abs(scoreDelta).toFixed(1)}%
        </span>
        <span style={{ color: C.t3 }}>vs previous period</span>
      </div>
    </div>
  );
}

// ── Donut chart (content mix wheel) ──────────────────────────────────────────

export function Donut({
  slices,
  size = 132,
  thickness = 16,
  centerTop,
  centerBottom,
}: {
  slices: Array<{ label: string; value: number; color: string }>;
  size?: number;
  thickness?: number;
  centerTop?: string | number;
  centerBottom?: string;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  let acc = 0;

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)", width: "100%", height: "100%" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.track} strokeWidth={thickness} />
        {slices.map((slice, i) => {
          const frac = slice.value / total;
          const dash = frac * circ;
          const off = -acc * circ;
          acc += frac;
          return (
            <circle
              key={i}
              cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={slice.color} strokeWidth={thickness}
              strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={off}
            />
          );
        })}
      </svg>
      {(centerTop !== undefined || centerBottom) && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          {centerTop !== undefined && (
            <span style={{ fontSize: 24, fontWeight: 800, color: C.t1, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{centerTop}</span>
          )}
          {centerBottom && <span style={{ fontSize: 10.5, color: C.t3, marginTop: 2 }}>{centerBottom}</span>}
        </div>
      )}
    </div>
  );
}

// ── Narrative highlighter ────────────────────────────────────────────────────
// Wraps numbers, percentages, multipliers and currency in an accent-bold span
// so the changing values pop, the rest reads as muted prose (mock storytelling).

// Tiers (mock storytelling, NOT all-one-color):
//   • "up N%" / "ahead"  → green     (positive movement)
//   • "down N%"          → red       (negative movement)
//   • quoted "post title" → accent, normal weight (a referenced thing, distinct)
//   • bare metrics (N, N.NK, N%, NM) → white + bold (the key numbers)
//   • everything else    → muted prose
export function highlightNarrative(text: string): ReactNode[] {
  const re =
    /("[^"]+")|(\bup\s+[\d.,]+%)|(\bdown\s+[\d.,]+%)|(\bahead of pace\b)|(\$?\d[\d,.]*(?:K|M)?%?)/gi;
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(<span key={`t${k++}`}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    if (m[1]) {
      // quoted post title — distinct, not bold
      nodes.push(<span key={`q${k++}`} style={{ color: C.accentB, fontWeight: 500 }}>{tok}</span>);
    } else if (m[2] || m[4]) {
      // positive movement
      nodes.push(<strong key={`p${k++}`} style={{ color: C.green, fontWeight: 700 }}>{tok}</strong>);
    } else if (m[3]) {
      // negative movement
      nodes.push(<strong key={`n${k++}`} style={{ color: C.red, fontWeight: 700 }}>{tok}</strong>);
    } else {
      // key metric number
      nodes.push(<strong key={`m${k++}`} style={{ color: C.t1, fontWeight: 700 }}>{tok}</strong>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(<span key={`t${k++}`}>{text.slice(last)}</span>);
  return nodes;
}

// ── Skeleton loader ──────────────────────────────────────────────────────────

export function Skeleton({
  w = "100%",
  h = 16,
  style,
}: {
  w?: string | number;
  h?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: 6,
        background: `linear-gradient(90deg, ${C.surface} 25%, ${C.surfaceB} 50%, ${C.surface} 75%)`,
        backgroundSize: "200% 100%",
        animation: "shimmer 1.4s infinite",
        ...style,
      }}
    />
  );
}

// ── Section card wrapper ─────────────────────────────────────────────────────

export function SectionCard({
  title,
  eyebrow,
  children,
  action,
  style,
}: {
  title:    string;
  eyebrow?: string;
  children: ReactNode;
  action?:  ReactNode;
  style?:   CSSProperties;
}) {
  return (
    <div
      style={{
        background:    C.surface,
        border:        `1px solid ${C.border}`,
        borderRadius:  16,
        padding:       "24px 28px",
        display:       "flex",
        flexDirection: "column",
        gap:           20,
        ...style,
      }}
    >
      <div
        style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          {eyebrow && (
            <div
              style={{
                fontSize:      11,
                fontWeight:    600,
                color:         C.t3,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom:  4,
              }}
            >
              {eyebrow}
            </div>
          )}
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.t1 }}>
            {title}
          </h2>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// ── Panel (bordered card body; header sits above it via SectionHeader) ───────

export function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background:   C.surface,
        border:       `1px solid ${C.border}`,
        borderRadius: 16,
        padding:      "22px 24px",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Delta badge ──────────────────────────────────────────────────────────────

export function DeltaBadge({
  delta,
  trend,
}: {
  delta: number;
  trend?: "up" | "down" | "neutral";
}) {
  const dir   = trend ?? (delta >= 0 ? "up" : "down");
  const color = dir === "up" ? C.green : dir === "down" ? C.red : C.t3;
  const bg    = dir === "up" ? "#16532520" : dir === "down" ? "#7f1d1d20" : `${C.t3}20`;

  return (
    <span
      style={{
        display:     "inline-flex",
        alignItems:  "center",
        gap:         3,
        padding:     "2px 8px",
        borderRadius: 99,
        fontSize:    12,
        fontWeight:  600,
        color,
        background:  bg,
      }}
    >
      {dir === "up" ? "▲" : dir === "down" ? "▼" : "●"}{" "}
      {Math.abs(delta).toFixed(1)}%
    </span>
  );
}

// ── Metric tile ──────────────────────────────────────────────────────────────

export function MetricTile({
  label,
  value,
  sub,
  delta,
  trend,
}: {
  label: string;
  value: string | number;
  sub?:  string;
  delta?: number;
  trend?: "up" | "down" | "neutral";
}) {
  return (
    <div
      style={{
        background:    C.surfaceB,
        border:        `1px solid ${C.borderB}`,
        borderRadius:  12,
        padding:       "16px 18px",
        display:       "flex",
        flexDirection: "column",
        gap:           6,
      }}
    >
      <div style={{ fontSize: 12, color: C.t3, fontWeight: 500 }}>{label}</div>
      <div
        style={{
          fontSize:             22,
          fontWeight:           700,
          color:                C.t1,
          fontVariantNumeric:   "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {delta !== undefined && <DeltaBadge delta={delta} trend={trend} />}
        {sub && <span style={{ fontSize: 11, color: C.t3 }}>{sub}</span>}
      </div>
    </div>
  );
}

// ── Platform dot ─────────────────────────────────────────────────────────────

export function PlatformDot({ platform }: { platform: string }) {
  return (
    <span
      style={{
        display:      "inline-block",
        width:        8,
        height:       8,
        borderRadius: "50%",
        background:   platformColor[platform] ?? C.t3,
        flexShrink:   0,
      }}
    />
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────

export function StatusBadge({
  status,
}: {
  status: "pending" | "published" | "failed";
}) {
  const color =
    status === "published" ? C.green :
    status === "failed"    ? C.red   : C.amber;

  return (
    <span
      style={{
        fontSize:     11,
        fontWeight:   600,
        padding:      "2px 8px",
        borderRadius: 99,
        background:   `${color}20`,
        color,
      }}
    >
      {status}
    </span>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

export function EmptyState({
  message,
  action,
}: {
  message: string;
  /** Optional call-to-action link rendered under the message. */
  action?: { label: string; href: string };
}) {
  return (
    <div
      style={{
        padding:   "32px 0",
        textAlign: "center",
        color:     C.t3,
        fontSize:  13,
      }}
    >
      {message}
      {action && (
        <div style={{ marginTop: 12 }}>
          <a
            href={action.href}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              fontSize: 12.5, fontWeight: 600, color: C.accentB,
              background: `${C.accentB}1c`, border: `1px solid ${C.accentB}55`,
              borderRadius: 99, padding: "6px 14px", textDecoration: "none",
            }}
          >
            {action.label}
          </a>
        </div>
      )}
    </div>
  );
}

// ── Error state ───────────────────────────────────────────────────────────────

export function ErrorState({
  message,
  onRetry,
}: {
  message:  string;
  onRetry?: () => void;
}) {
  return (
    <div
      style={{
        padding:        "16px 20px",
        background:     "#7f1d1d18",
        border:         `1px solid ${C.red}30`,
        borderRadius:   10,
        fontSize:       13,
        color:          C.red,
        display:        "flex",
        alignItems:     "center",
        justifyContent: "space-between",
        gap:            12,
      }}
    >
      <span>{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            background:   "none",
            border:       `1px solid ${C.red}60`,
            color:        C.red,
            borderRadius: 6,
            padding:      "4px 10px",
            cursor:       "pointer",
            fontSize:     12,
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ── Loading rows (skeleton list) ──────────────────────────────────────────────

export function LoadingRows({ n = 3 }: { n?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {Array.from({ length: n }).map((_, i) => (
        <Skeleton key={i} h={48} />
      ))}
    </div>
  );
}

// ── Divider ───────────────────────────────────────────────────────────────────

export function Divider({ vertical = false }: { vertical?: boolean }) {
  return (
    <div
      style={
        vertical
          ? { width: 1, alignSelf: "stretch", background: C.border }
          : { height: 1, width: "100%", background: C.border }
      }
    />
  );
}
