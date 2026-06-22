// ─────────────────────────────────────────────────────────────────────────────
// InsightsFilters.tsx
// Period segmented control + platform chip picker.
// Lift period/platform state to whichever parent assembles the dashboard.
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform } from "@/frontend/insights/types";
import { C, platformColor, platformLabel } from "@/frontend/insights/tokens";

interface InsightsFiltersProps {
  period:          Period;
  platform:        Platform;
  onPeriodChange:  (p: Period)   => void;
  onPlatformChange:(p: Platform) => void;
}

const PERIOD_OPTS: Array<{ value: Period; label: string }> = [
  { value: "week",  label: "This week" },
  { value: "30day", label: "30 days"   },
  { value: "90day", label: "90 days"   },
];

const PLATFORM_OPTS: Array<{ value: Platform; label: string }> = [
  { value: "all",       label: "All channels" },
  { value: "instagram", label: "Instagram"    },
  { value: "facebook",  label: "Facebook"     },
  { value: "youtube",   label: "YouTube"      },
  { value: "tiktok",    label: "TikTok"       },
];

export function InsightsFilters({
  period,
  platform,
  onPeriodChange,
  onPlatformChange,
}: InsightsFiltersProps) {
  return (
    <div
      style={{
        display:     "flex",
        alignItems:  "center",
        gap:         12,
        flexWrap:    "wrap",
        marginBottom: 28,
      }}
    >
      {/* ── Period segmented control ── */}
      <div
        style={{
          display:      "flex",
          gap:          2,
          background:   C.surfaceB,
          padding:      3,
          borderRadius: 10,
          border:       `1px solid ${C.border}`,
        }}
        role="group"
        aria-label="Time period"
      >
        {PERIOD_OPTS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onPeriodChange(opt.value)}
            aria-pressed={period === opt.value}
            style={{
              padding:      "6px 14px",
              borderRadius: 7,
              border:       "none",
              cursor:       "pointer",
              fontSize:     12,
              fontWeight:   500,
              background:   period === opt.value ? C.accent : "transparent",
              color:        period === opt.value ? "#fff" : C.t3,
              transition:   "background 0.15s, color 0.15s",
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 24, background: C.border }} />

      {/* ── Platform chips ── */}
      <div
        style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
        role="group"
        aria-label="Platform filter"
      >
        {PLATFORM_OPTS.map((opt) => {
          const active = platform === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onPlatformChange(opt.value)}
              aria-pressed={active}
              style={{
                padding:      "5px 12px",
                borderRadius: 99,
                border:       `1px solid ${active ? C.accent : C.border}`,
                cursor:       "pointer",
                fontSize:     12,
                fontWeight:   500,
                background:   active ? `${C.accent}18` : "transparent",
                color:        active ? C.accentB : C.t3,
                transition:   "all 0.15s",
                display:      "flex",
                alignItems:   "center",
                gap:          5,
              }}
            >
              {opt.value !== "all" && (
                <span
                  style={{
                    width:        6,
                    height:       6,
                    borderRadius: "50%",
                    background:   platformColor[opt.value],
                    display:      "inline-block",
                    flexShrink:   0,
                  }}
                />
              )}
              {opt.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />

      {/* Context label */}
      <span style={{ fontSize: 11, color: C.t3 }}>
        {platformLabel[platform]}
        {" · "}
        {period === "week" ? "This week" : period === "30day" ? "Last 30 days" : "Last 90 days"}
      </span>
    </div>
  );
}
