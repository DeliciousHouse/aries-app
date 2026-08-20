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
// The Monday-relative arithmetic for the client-side stepper reuses the exact
// same ISO-week rule the server resolves `?week=` against, imported directly
// rather than duplicated: this module is pure math (no `server-only`, no
// `@/lib/db`, zero imports) so it is safe to pull into a component tree that
// has no 'use client' directive of its own (it inherits the client boundary
// from InsightsDashboard.tsx, same as every other section). Two ISO-week
// implementations drifting apart by one week is exactly the bug class this
// card exists to eliminate — see weekly-recap-week.ts for the "most recent
// completed week" default, which stays server-only; the client only ever
// shifts Mondays relative to a week the server already resolved.
import { isoWeekParts } from "@/backend/insights/weekly-recap/weekly-recap-week";

/** The ISO week id `deltaWeeks` away from the week whose Monday is `startYmd` (YYYY-MM-DD, UTC). */
function shiftedWeekIso(startYmd: string, deltaWeeks: number): string {
  const [y, m, d] = startYmd.split("-").map(Number);
  const monday = new Date(Date.UTC(y, m - 1, d + deltaWeeks * 7));
  const { year, week } = isoWeekParts(monday);
  return `${year}-W${String(week).padStart(2, "0")}`;
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

function formatEngagementAverage(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
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

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 18 }}>
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

        {/* The worker compares the completed week with the week before it. */}
        {report.engagementTrend && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: C.t3, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
              Engagement trend
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: C.t1 }}>
              {report.engagementTrend.direction === "upward" && "↑ Upward"}
              {report.engagementTrend.direction === "downward" && "↓ Downward"}
              {report.engagementTrend.direction === "flat" && "→ Flat"}
              {report.engagementTrend.direction === "insufficient_data" && "Not enough comparable data"}
              {report.engagementTrend.changePercent !== null && ` · ${Math.abs(report.engagementTrend.changePercent).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`}
            </div>
            <div style={{ fontSize: 11.5, color: C.t3, marginTop: 4 }}>
              Average engagement per measured post: {formatEngagementAverage(report.engagementTrend.currentAverage)} this week vs {formatEngagementAverage(report.engagementTrend.previousAverage)} previously
            </div>
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

export function WeeklyRecapSection({
  /** Injected in tests; real callers get the browser's print dialog. */
  onPrint,
}: { onPrint?: () => void } = {}) {
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

  const print = () => {
    if (onPrint) return onPrint();
    if (typeof window !== "undefined") window.print();
  };

  return (
    // S8-3/AA-126: the marker every print rule in globals.css is scoped to.
    // AA-229/PR2b moved this report out of its own page and onto /insights
    // alongside nine other sections, so the print stylesheet now has to hide
    // those siblings too — otherwise Cmd+P yields the whole dashboard instead of
    // the one-page recap a client is meant to receive.
    <section id="weekly-recap" data-print-report>
      {/* Print-only masthead. On screen the section header and the page chrome
          say what this is; on paper the reader needs the brand, the week it
          covers and when it was produced. */}
      {report ? (
        <div className="hidden print:block" data-testid="weekly-recap-print-header">
          <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.24em" }}>
            Aries AI
          </p>
          <h2 style={{ margin: "4px 0 0", fontSize: 20, fontWeight: 600 }}>
            Weekly recap — {report.week.label}
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 12 }}>
            {report.week.startYmd} to {report.week.endYmd} · Generated{" "}
            {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
          </p>
        </div>
      ) : null}

      <SectionHeader
        title="Weekly recap"
        note={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span>{scopeLine}</span>
            {/* The week stepper and the print control are things you CLICK.
                On paper they are dead ink, and a disabled arrow reads as a
                rendering fault. */}
            <span data-print-hidden className="print-hidden" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <StepButton label="‹" ariaLabel="Previous week" disabled={loading || !report} onClick={goPrev} />
              <StepButton label="›" ariaLabel="Next week" disabled={loading || !report || selectedWeek === null} onClick={goNext} />
              <button
                type="button"
                onClick={print}
                data-print-hidden
                data-testid="weekly-recap-print-button"
                className="print-hidden"
                style={{
                  marginLeft: 6,
                  padding: "4px 10px",
                  borderRadius: 8,
                  border: `1px solid ${C.border}`,
                  background: "transparent",
                  color: "inherit",
                  font: "inherit",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Print / Save as PDF
              </button>
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
