// ─────────────────────────────────────────────────────────────────────────────
// Header.tsx
// Top bar: brand mark, page title, notifications + help buttons.
// ─────────────────────────────────────────────────────────────────────────────

import type { CSSProperties } from "react";
import { C } from "@/frontend/insights/tokens";

interface HeaderProps {
  pageTitle:    string;
  brandName?:   string;
  brandMeta?:   string;
  brandInitials?: string;
  onNotifications?: () => void;
  onHelp?:      () => void;
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label:    string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const base: CSSProperties = {
    width:          34,
    height:         34,
    borderRadius:   8,
    background:     "none",
    border:         `1px solid ${C.border}`,
    color:          C.t3,
    cursor:         "pointer",
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    transition:     "color 0.15s, border-color 0.15s",
  };

  return (
    <button
      aria-label={label}
      onClick={onClick}
      style={base}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.color        = C.t1;
        (e.currentTarget as HTMLElement).style.borderColor  = C.borderB;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.color        = C.t3;
        (e.currentTarget as HTMLElement).style.borderColor  = C.border;
      }}
    >
      {children}
    </button>
  );
}

export function Header({
  pageTitle,
  brandName      = "Atelier North",
  brandMeta      = "Residential Interior Design · Austin",
  brandInitials  = "AN",
  onNotifications,
  onHelp,
}: HeaderProps) {
  return (
    <header
      style={{
        background:   C.surface,
        borderBottom: `1px solid ${C.border}`,
        padding:      "0 28px",
        height:       60,
        display:      "flex",
        alignItems:   "center",
        gap:          16,
        position:     "sticky",
        top:          0,
        zIndex:       10,
        flexShrink:   0,
      }}
    >
      {/* Brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width:          32,
            height:         32,
            borderRadius:   8,
            background:     `${C.accent}18`,
            border:         `1px solid ${C.accent}38`,
            display:        "flex",
            alignItems:     "center",
            justifyContent: "center",
            fontSize:       11,
            fontWeight:     700,
            color:          C.accentB,
            flexShrink:     0,
            userSelect:     "none",
          }}
        >
          {brandInitials}
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.t1, lineHeight: 1.2 }}>
            {brandName}
          </div>
          <div style={{ fontSize: 11, color: C.t3 }}>
            {brandMeta}
          </div>
        </div>
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 28, background: C.border, marginLeft: 4 }} />

      {/* Page title */}
      <span style={{ fontSize: 14, fontWeight: 600, color: C.t2 }}>
        {pageTitle}
      </span>

      <div style={{ flex: 1 }} />

      {/* Action buttons */}
      <IconButton label="Notifications" onClick={onNotifications}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
      </IconButton>

      <IconButton label="Help" onClick={onHelp}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </IconButton>
    </header>
  );
}
