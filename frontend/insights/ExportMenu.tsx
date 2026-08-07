"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ExportMenu.tsx — S5-3 / AA-112 (gap F2a)
//
// CSV download for the operator's own insights data, on the /insights control
// row (the header of the dashboard content, alongside the filters it respects
// and the freshness stamp). Plain <a download> links: the endpoint answers with
// Content-Disposition, so the browser handles the save with no JS, no blob and
// no in-memory copy of the file.
//
// Comments are deliberately absent — see backend/insights/export/export-datasets.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { C } from "@/frontend/insights/tokens";
import type { Period, Platform } from "@/frontend/insights/types";

const PERIOD_DAYS: Record<Period, number> = {
  week: 7,
  "30day": 30,
  "90day": 90,
};

function exportHref(dataset: string, period: Period, platform: Platform): string {
  const params = new URLSearchParams({ dataset, days: String(PERIOD_DAYS[period] ?? 90) });
  if (platform !== "all") params.set("platform", platform);
  return `/api/insights/export?${params.toString()}`;
}

export function ExportMenu({ period, platform }: { period: Period; platform: Platform }) {
  const [open, setOpen] = useState(false);

  const itemStyle: React.CSSProperties = {
    display: "block",
    padding: "8px 12px",
    fontSize: 12,
    color: C.t2,
    textDecoration: "none",
    whiteSpace: "nowrap",
  };

  return (
    <div style={{ position: "relative" }} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: "none",
          color: C.t3,
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Export CSV
      </button>

      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: 4,
            zIndex: 20,
            minWidth: 190,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          <a role="menuitem" href={exportHref("posts", period, platform)} download style={itemStyle}>
            Posts
          </a>
          <a
            role="menuitem"
            href={exportHref("account-metrics", period, platform)}
            download
            style={itemStyle}
          >
            Daily account metrics
          </a>
        </div>
      ) : null}
    </div>
  );
}

export default ExportMenu;
