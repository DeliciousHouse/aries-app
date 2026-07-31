// ─────────────────────────────────────────────────────────────────────────────
// InsightsFilters.tsx
// PERIOD segmented control + CHANNEL chip picker (with brand logos).
// Sits directly under the hero band (see app/insights/page.tsx).
// ─────────────────────────────────────────────────────────────────────────────

import type { Period, Platform } from "@/frontend/insights/types";
import { C, platformLabel } from "@/frontend/insights/tokens";
import { ChannelIcon } from "@/frontend/insights/ui";

interface InsightsFiltersProps {
  period:           Period;
  platform:         Platform;
  onPeriodChange:   (p: Period)   => void;
  onPlatformChange: (p: Platform) => void;
  /** Platforms with a live insights adapter for this deployment, resolved
   *  server-side in app/insights/page.tsx. */
  enabledPlatforms: readonly Platform[];
}

const PERIOD_OPTS: Array<{ value: Period; label: string }> = [
  { value: "week",  label: "This week" },
  { value: "30day", label: "30 days"   },
  { value: "90day", label: "90 days"   },
];

/**
 * Platform chips are derived, never hardcoded.
 *
 * The old static list carried a TikTok chip with no adapter behind it
 * (backend/insights/platforms/registry.ts has no tiktok, and
 * backend/insights/adapters/ has no tiktok directory), so selecting it could
 * only ever return nothing. It also omitted X, Reddit and LinkedIn, which do
 * have adapters.
 *
 * `enabledPlatforms` comes from the server page, which asks
 * `isPlatformInsightsEnabled()` — the same predicate the sync adapter factory
 * uses. So a chip exists exactly when an adapter can produce data for it, and
 * the two cannot drift.
 */
function platformOptions(enabledPlatforms: readonly Platform[]): Array<{ value: Platform; label: string }> {
  return [
    { value: "all" as Platform, label: platformLabel.all ?? "All channels" },
    ...enabledPlatforms.map((value) => ({ value, label: platformLabel[value] ?? value })),
  ];
}

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
  enabledPlatforms,
}: InsightsFiltersProps) {
  const platformOpts = platformOptions(enabledPlatforms);
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
        {platformOpts.map((opt) => {
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
