// ─────────────────────────────────────────────────────────────────────────────
// ui.tsx — Shared primitive components used across all Insights sections
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode, CSSProperties } from "react";
import { C, platformColor } from "@/frontend/insights/tokens";

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

export function EmptyState({ message }: { message: string }) {
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
