// ─────────────────────────────────────────────────────────────────────────────
// Sidebar.tsx
// Persistent left-nav for the Aries dashboard.
// Pass `activePage` to highlight the current route.
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import type { CSSProperties, MouseEventHandler } from "react";
import { C } from "@/frontend/insights/tokens";

type NavPage =
  | "home"
  | "compose"
  | "calendar"
  | "conversations"
  | "campaigns"
  | "connections"
  | "insights"
  | "settings";

interface SidebarProps {
  activePage?: NavPage;
  /** Optional override if routing is handled by React Router / Next.js <Link> */
  onNavigate?: (page: NavPage) => void;
}

interface NavItem {
  id:    NavPage;
  label: string;
  href:  string;
  icon:  React.ReactElement;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "home", label: "Home", href: "home.html",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
        <path d="M3 12l9-9 9 9"/><path d="M5 10v10a1 1 0 0 0 1 1h3v-6h6v6h3a1 1 0 0 0 1-1V10"/>
      </svg>
    ),
  },
  {
    id: "compose", label: "Compose", href: "compose.html",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
    ),
  },
  {
    id: "calendar", label: "Calendar", href: "calendar.html",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
    ),
  },
  {
    id: "conversations", label: "Conversations", href: "conversations.html",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    ),
  },
  {
    id: "campaigns", label: "Campaigns", href: "campaigns.html",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
        <polygon points="12 2 2 7 12 12 22 7 12 2"/>
        <polyline points="2 17 12 22 22 17"/>
        <polyline points="2 12 12 17 22 12"/>
      </svg>
    ),
  },
  {
    id: "connections", label: "Connections", href: "connections.html",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
        <line x1="6" y1="3" x2="6" y2="15"/>
        <circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
        <path d="M18 9a9 9 0 0 1-9 9"/>
      </svg>
    ),
  },
  {
    id: "insights", label: "Insights", href: "index.html",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
        <line x1="18" y1="20" x2="18" y2="10"/>
        <line x1="12" y1="20" x2="12" y2="4"/>
        <line x1="6" y1="20" x2="6" y2="14"/>
      </svg>
    ),
  },
  {
    id: "settings", label: "Settings", href: "settings.html",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    ),
  },
];

export function Sidebar({ activePage = "insights", onNavigate }: SidebarProps) {
  const itemStyle = (active: boolean): CSSProperties => ({
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    width:          40,
    height:         40,
    borderRadius:   10,
    color:          active ? C.accent : C.t3,
    background:     active ? `${C.accent}18` : "transparent",
    textDecoration: "none",
    border:         "none",
    cursor:         "pointer",
    transition:     "color 0.15s, background 0.15s",
  });

  const handleHover: MouseEventHandler<HTMLAnchorElement> = (e) => {
    const el = e.currentTarget;
    if (!el.getAttribute("aria-current")) {
      el.style.color      = C.t1;
      el.style.background = C.surfaceB;
    }
  };
  const handleLeave: MouseEventHandler<HTMLAnchorElement> = (e) => {
    const el = e.currentTarget;
    if (!el.getAttribute("aria-current")) {
      el.style.color      = C.t3;
      el.style.background = "transparent";
    }
  };

  return (
    <aside
      style={{
        width:          60,
        background:     C.surface,
        borderRight:    `1px solid ${C.border}`,
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "center",
        padding:        "16px 0",
        position:       "sticky",
        top:            0,
        height:         "100vh",
        flexShrink:     0,
        zIndex:         20,
      }}
      aria-label="Primary navigation"
    >
      {/* Logo */}
      <div
        style={{
          width:          34,
          height:         34,
          borderRadius:   10,
          background:     `linear-gradient(135deg, ${C.accent}, ${C.accentB})`,
          display:        "flex",
          alignItems:     "center",
          justifyContent: "center",
          fontSize:       15,
          fontWeight:     800,
          color:          "#fff",
          marginBottom:   20,
          flexShrink:     0,
          userSelect:     "none",
        }}
        title="Aries AI"
      >
        A
      </div>

      {/* Nav items */}
      <nav
        style={{
          display:        "flex",
          flexDirection:  "column",
          gap:            4,
          flex:           1,
          alignItems:     "center",
        }}
      >
        {NAV_ITEMS.map((item) => {
          const active = item.id === activePage;
          return (
            <a
              key={item.id}
              href={onNavigate ? undefined : item.href}
              title={item.label}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              onClick={
                onNavigate
                  ? (e) => {
                      e.preventDefault();
                      onNavigate(item.id);
                    }
                  : undefined
              }
              style={itemStyle(active)}
              onMouseEnter={handleHover}
              onMouseLeave={handleLeave}
            >
              {item.icon}
            </a>
          );
        })}
      </nav>

      {/* User avatar */}
      <div
        style={{
          width:          32,
          height:         32,
          borderRadius:   "50%",
          background:     `${C.accent}30`,
          border:         `1px solid ${C.accent}50`,
          display:        "flex",
          alignItems:     "center",
          justifyContent: "center",
          fontSize:       13,
          fontWeight:     700,
          color:          C.accentB,
          cursor:         "default",
          userSelect:     "none",
          flexShrink:     0,
        }}
        title="Account"
      >
        ·
      </div>
    </aside>
  );
}
