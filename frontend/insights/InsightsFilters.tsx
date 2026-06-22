// ─────────────────────────────────────────────────────────────────────────────
// InsightsFilters.tsx
// PERIOD segmented control + CHANNEL chip picker (with brand logos).
// Sits directly under the hero band (see app/insights/page.tsx).
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform } from "@/frontend/insights/types";
import { C } from "@/frontend/insights/tokens";
import { ChannelIcon } from "@/frontend/insights/ui";

interface InsightsFiltersProps {
  period:           Period;
  platform:         Platform;
  onPeriodChange:   (p: Period)   => void;
  onPlatformChange: (p: Platform) => void;
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

function GroupLabel({ children }: { children: string }) {
  return (
    <span
      style={{
        fontSize:      10,
        fontWeight:    700,
        color:         C.t3,
        textTransform: "uppercase",
        letterSpacing: "0.09em",
        marginRight:   2,
      }}
    >
      {children}
    </span>
  );
}

export function InsightsFilters({
  period,
  platform,
  onPeriodChange,
  onPlatformChange,
}: InsightsFiltersProps) {
  return (
    <div
      style={{
        display:    "flex",
        alignItems: "center",
        gap:        14,
        flexWrap:   "wrap",
      }}
    >
      {/* ── PERIOD ── */}
      <GroupLabel>Period</GroupLabel>
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
        {PERIOD_OPTS.map((opt) => {
          const active = period === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onPeriodChange(opt.value)}
              aria-pressed={active}
              style={{
                padding:      "6px 14px",
                borderRadius: 7,
                border:       "none",
                cursor:       "pointer",
                fontSize:     12.5,
                fontWeight:   600,
                background:   active ? C.accent : "transparent",
                color:        active ? "#fff" : C.t3,
                transition:   "background 0.15s, color 0.15s",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div style={{ width: 1, height: 22, background: C.border, margin: "0 2px" }} />

      {/* ── CHANNEL ── */}
      <GroupLabel>Channel</GroupLabel>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="group" aria-label="Channel filter">
        {PLATFORM_OPTS.map((opt) => {
          const active = platform === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onPlatformChange(opt.value)}
              aria-pressed={active}
              style={{
                padding:      "5px 11px 5px 9px",
                borderRadius: 99,
                border:       `1px solid ${active ? C.accent : C.border}`,
                cursor:       "pointer",
                fontSize:     12.5,
                fontWeight:   active ? 600 : 500,
                background:   active ? `${C.accent}1f` : "transparent",
                color:        active ? C.t1 : C.t2,
                transition:   "all 0.15s",
                display:      "flex",
                alignItems:   "center",
                gap:          6,
              }}
            >
              <ChannelIcon platform={opt.value} size={14} />
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
