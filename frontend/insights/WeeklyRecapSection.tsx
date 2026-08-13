// ─────────────────────────────────────────────────────────────────────────────
// WeeklyRecapSection.tsx
// Section 10 — Weekly recap: published/skipped/blocked outcomes for the most
// recent completed week, the #519 reconnect signal, the top channel, and the
// derived publish-reliability learnings + single next action.
// API: GET /api/insights/weekly-recap?week=… (60s micro-cache, AA-229/PR2b)
//
// AA-229/PR2b relocated this out of the standalone /dashboard/results page
// (S5-1/AA-110) into /insights as its own section. It carries the ONLY urgent
// items on this page (blocked dispatches, "Reconnect Meta"), so it renders
// eagerly — never behind <LazyInsightSection> — and full-width, between the
// filter row and the Goal section.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

import type { WeeklyRecapData, WeeklyRecapLearning, WeeklyRecapReport } from "@/frontend/insights/types";
import { useInsight } from "@/frontend/insights/useInsight";
import { C } from "@/frontend/insights/tokens";
import {
  SectionHeader,
  Panel,
  Icon,
  ErrorState,
  EmptyState,
  LoadingRows,
  Divider,
} from "@/frontend/insights/ui";

// ── ISO week math for the client-side stepper ────────────────────────────────
// Mirrors backend/insights/weekly-recap/weekly-recap-week.ts::isoWeekParts
// exactly (the "nearest Thursday" rule). Duplicated rather than imported: this
// is a 'use client' component and that module lives under backend/ (server
// only) — keep the two in sync if the algorithm ever changes.
const DAY_MS = 24 * 60 * 60 * 1000;

function isoWeekIdOfMonday(monday: Date): string {
  const d = new Date(monday.getTime());
  const dayNum = d.getUTCDay() || 7; // Mon=1 … Sun=7 (always 1 for a Monday, but keep the general form)
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** The ISO week id `deltaWeeks` away from the week whose Monday is `startYmd` (YYYY-MM-DD, UTC). */
function shiftedWeekIso(startYmd: string, deltaWeeks: number): string {
  const [y, m, d] = startYmd.split("-").map(Number);
  const monday = new Date(Date.UTC(y, m - 1, d + deltaWeeks * 7));
  return isoWeekIdOfMonday(monday);
}

function titleCase(value: string): string {
  return value.length ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

// ── Week stepper ──────────────────────────────────────────────────────────────

function StepButton({
  label,
  ariaLabel,
  disabled,
  onClick,
}: {
  label:     string;
  ariaLabel: string;
  disabled:  boolean;
  onClick:   () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        width:          26,
        height:         26,
        borderRadius:   7,
        border:         `1px solid ${C.border}`,
        background:     C.surfaceB,
        color:          disabled ? C.t3 : C.t1,
        cursor:         disabled ? "not-allowed" : "pointer",
        display:        "inline-flex",
        alignItems:     "center",
        justifyContent: "center",
        fontSize:       13,
        lineHeight:     1,
        opacity:        disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

// ── Stat tile (Published / Skipped / Blocked) ────────────────────────────────

function StatTile({
  label,
  value,
  detail,
  tone = "default",
  action,
}: {
  label:  string;
  value:  number;
  detail: string;
  tone?:  "default" | "watch";
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        background:    C.surfaceB,
        border:        `1px solid ${tone === "watch" && value > 0 ? `${C.amber}45` : C.borderB}`,
        borderRadius:  12,
        padding:       "16px 18px",
        display:       "flex",
        flexDirection: "column",
        gap:           6,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: C.t3, textTransform: "uppercase", letterSpacing: "0.07em" }}>
        {label}
      </div>
      <div
        style={{
          fontSize:   28,
          fontWeight: 800,
          lineHeight: 1,
          color:      tone === "watch" && value > 0 ? C.amber : C.t1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: C.t3, lineHeight: 1.5 }}>{detail}</div>
      {action}
    </div>
  );
}

function channelDetail(byChannel: Record<string, number>): string {
  const entries = Object.entries(byChannel);
  if (entries.length === 0) return "No posts published this week.";
  return entries.map(([channel, n]) => `${titleCase(channel)} ${n}`).join(" · ");
}

// ── Learnings + next action ──────────────────────────────────────────────────

function LearningCard({ learning }: { learning: WeeklyRecapLearning }) {
  return (
    <div
      style={{
        background:   C.surfaceB,
        border:       `1px solid ${C.borderB}`,
        borderRadius: 12,
        padding:      "14px 16px",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>{learning.title}</div>
      <div style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.55, marginTop: 4 }}>{learning.body}</div>
    </div>
  );
}

function NextActionCard({ nextAction }: { nextAction: NonNullable<WeeklyRecapReport["nextAction"]> }) {
  return (
    <div
      style={{
        background:   C.surfaceB,
        border:       `1px solid ${C.accent}35`,
        borderRadius: 12,
        padding:      "14px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 700, color: C.accentB, textTransform: "uppercase", letterSpacing: "0.07em" }}>
        <Icon name="spark" size={12} color={C.accentB} />
        Recommended next week
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.t1, marginTop: 6 }}>{nextAction.title}</div>
      <div style={{ fontSize: 12.5, color: C.t2, lineHeight: 1.55, marginTop: 4 }}>{nextAction.body}</div>
      {nextAction.href && (
        <a
          href={nextAction.href}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10,
            fontSize: 12, fontWeight: 600, color: C.accentB,
            background: `${C.accentB}1c`, border: `1px solid ${C.accentB}55`,
            borderRadius: 8, padding: "6px 12px", textDecoration: "none",
          }}
        >
          Take me there
        </a>
      )}
    </div>
  );
}

// ── Recap body (the fully-loaded report) ─────────────────────────────────────

function RecapBody({ report }: { report: WeeklyRecapReport }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {/* Published / Skipped / Blocked */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <StatTile
          label="Published"
          value={report.published.total}
          detail={channelDetail(report.published.byChannel)}
        />
        <StatTile label="Skipped" value={report.skipped.total} detail={report.skipped.note} />
        <StatTile
          label="Blocked"
          value={report.blocked.total}
          detail={report.blocked.reconnect ? "A channel connection needs reauthorizing." : "Dispatches that ended in a failure."}
          tone="watch"
          action={
            report.blocked.reconnect ? (
              <a
                href="/dashboard/settings/channel-integrations"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8,
                  fontSize: 12, fontWeight: 600, color: C.amber,
                  background: `${C.amber}1c`, border: `1px solid ${C.amber}55`,
                  borderRadius: 8, padding: "6px 12px", textDecoration: "none",
                }}
              >
                Reconnect Meta
              </a>
            ) : null
          }
        />
      </div>

      {/* Parked for manual confirmation — deliberately its own count, never
          folded into "blocked": the outcome is unconfirmed, not failed. */}
      {report.needsReconciliation.total > 0 && (
        <div
          style={{
            display: "flex", gap: 8, alignItems: "flex-start",
            background: `${C.amber}10`, border: `1px solid ${C.amber}30`,
            borderRadius: 10, padding: "12px 14px",
          }}
        >
          <span style={{ flexShrink: 0, marginTop: 1 }}>
            <Icon name="info" size={13} color={C.amber} />
          </span>
          <p style={{ margin: 0, fontSize: 12.5, color: C.t2, lineHeight: 1.55 }}>
            {report.needsReconciliation.total} post{report.needsReconciliation.total === 1 ? "" : "s"} awaiting
            manual confirmation — the platform never confirmed the outcome, so they may or may not have gone live.
          </p>
        </div>
      )}

      <Divider />

      {/* Top channel */}
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: C.t3, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
          Top channel
        </div>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: C.t1 }}>
          {report.topChannel.channel
            ? `${titleCase(report.topChannel.channel)} — ${report.topChannel.value.toLocaleString("en-US")} ${
                report.topChannel.basis === "reach" ? "reach" : "posts published"
              }`
            : "No posts published this week"}
        </div>
        {report.topChannel.channel && (
          <div style={{ fontSize: 11.5, color: C.t3, marginTop: 4 }}>
            {report.topChannel.basis === "reach" ? "Ranked by reach" : "Ranked by posts published"}
          </div>
        )}
      </div>

      <Divider />

      {/* What Aries learned + the single next action */}
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: C.t3, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
          What Aries learned
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {report.learnings.map((learning) => (
            <LearningCard key={learning.id} learning={learning} />
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          {report.nextAction ? (
            <NextActionCard nextAction={report.nextAction} />
          ) : (
            <p style={{ margin: 0, fontSize: 12.5, color: C.t3, lineHeight: 1.55 }}>
              No adjustments recommended this week.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

export function WeeklyRecapSection() {
  // null = the most recent COMPLETED week (the server's default); stepping
  // sets an explicit `YYYY-Www` override.
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  // The iso id of the default/most-recent week, captured the first time we
  // load it, so "Next" knows when stepping forward lands back on "live"
  // (at which point we hand control back to the server default rather than
  // ask it for the current, still-in-progress week).
  const [latestWeekIso, setLatestWeekIso] = useState<string | null>(null);

  // This section owns its own ISO-week time axis, NOT the page's period /
  // platform filters — pass the LITERAL 'week' / 'all', never the live filter
  // values. useInsight always appends both to the URL regardless of what this
  // section does with them, so passing the page's filters here would refetch
  // an identical body every time someone toggles a filter, fragmenting the
  // client dedup map for no reason (this section never reads period/platform
  // server-side either — see backend/insights/weekly-recap/handler.ts).
  const { data, loading, error, refetch } = useInsight<WeeklyRecapData>(
    "weekly-recap",
    "week",
    "all",
    { week: selectedWeek ?? "" },
  );

  const report = data && data.enabled ? data.report : null;

  useEffect(() => {
    if (selectedWeek === null && report) setLatestWeekIso(report.week.iso);
  }, [selectedWeek, report]);

  const goPrev = () => {
    if (!report) return;
    setSelectedWeek(shiftedWeekIso(report.week.startYmd, -1));
  };
  const goNext = () => {
    if (!report || selectedWeek === null) return;
    const candidate = shiftedWeekIso(report.week.startYmd, 1);
    setSelectedWeek(candidate === latestWeekIso ? null : candidate);
  };

  const scopeLine = report ? `Week of ${report.week.label} · all channels` : "Its own week — not the filters above";

  return (
    <section id="weekly-recap">
      <SectionHeader
        title="Weekly recap"
        note={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span>{scopeLine}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <StepButton label="‹" ariaLabel="Previous week" disabled={loading || !report} onClick={goPrev} />
              <StepButton label="›" ariaLabel="Next week" disabled={loading || !report || selectedWeek === null} onClick={goNext} />
            </span>
          </span>
        }
      />
      <Panel>
        {loading ? (
          <LoadingRows n={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : !report ? (
          <EmptyState message="No recap available for this week." />
        ) : (
          <RecapBody report={report} />
        )}
      </Panel>
    </section>
  );
}

export default WeeklyRecapSection;
