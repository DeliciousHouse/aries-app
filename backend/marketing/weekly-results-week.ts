/**
 * Week-boundary math for the weekly results report (S5-1 / AA-110, phase A.1).
 *
 * Pure, no DB, no library. The report's week is the tenant's most-recent
 * COMPLETED ISO week — Monday 00:00:00 UTC through the following Monday
 * (exclusive) — with a `?week=YYYY-WW` override.
 *
 * UTC deliberately, and deliberately unlike the insights builders' tenant-local
 * windows (S2-3): those bucket a rolling N-day period where a day boundary
 * decides which posts fall in-window, so the tenant's calendar matters. This
 * report names a specific ISO week in its own label and its `?week=` override is
 * a shared, linkable identifier — resolving the same `2026-W31` to different
 * instants per tenant would make that label mean two different things.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportWeek {
  /** ISO week identifier, e.g. "2026-W31". */
  iso: string;
  /** Inclusive UTC start (Monday 00:00:00Z). */
  start: Date;
  /** EXCLUSIVE UTC end (the following Monday 00:00:00Z). */
  end: Date;
  startYmd: string;
  /** Inclusive last day (Sunday), for display only. */
  endYmd: string;
  label: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Midnight UTC on the given instant's date. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * ISO-8601 week-numbering year + week for a date. The ISO year is NOT always the
 * calendar year: 2027-01-01 falls in 2026-W53, and 2025-12-29 falls in 2026-W01.
 * Resolved via the "nearest Thursday" rule, which is what makes those cases work.
 */
export function isoWeekParts(date: Date): { year: number; week: number } {
  const d = startOfUtcDay(date);
  const dayNum = d.getUTCDay() || 7; // Mon=1 … Sun=7
  // Shift to the Thursday of this week; its calendar year IS the ISO year.
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return { year: isoYear, week };
}

/** Monday 00:00:00 UTC of the given ISO week-numbering year + week. */
export function isoWeekStart(year: number, week: number): Date {
  // Jan 4 is always in ISO week 1, by definition.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = jan4.getTime() - (jan4Day - 1) * DAY_MS;
  return new Date(week1Monday + (week - 1) * 7 * DAY_MS);
}

function formatLabel(start: Date, endInclusive: Date): string {
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  const sameYear = start.getUTCFullYear() === endInclusive.getUTCFullYear();
  return `${fmt(start, !sameYear)} – ${fmt(endInclusive, true)}`;
}

function buildWeek(start: Date): ReportWeek {
  const end = new Date(start.getTime() + 7 * DAY_MS);
  const endInclusive = new Date(end.getTime() - DAY_MS);
  const { year, week } = isoWeekParts(start);
  return {
    iso: `${year}-W${String(week).padStart(2, '0')}`,
    start,
    end,
    startYmd: ymd(start),
    endYmd: ymd(endInclusive),
    label: formatLabel(start, endInclusive),
  };
}

/**
 * The most-recent COMPLETED ISO week relative to `now`. The current (in-progress)
 * week is deliberately excluded — a report headed "this week" that counted three
 * days of a seven-day week would understate every number on the panel.
 */
export function mostRecentCompletedWeek(now: Date = new Date()): ReportWeek {
  const today = startOfUtcDay(now);
  const dayNum = today.getUTCDay() || 7;
  // Monday of the CURRENT week = the exclusive end of the last completed one.
  const thisMonday = new Date(today.getTime() - (dayNum - 1) * DAY_MS);
  return buildWeek(new Date(thisMonday.getTime() - 7 * DAY_MS));
}

const WEEK_ISO_RE = /^(\d{4})-W?(\d{1,2})$/i;

/**
 * Parse a `?week=YYYY-WW` (or `YYYY-Www`) override. Returns null for anything
 * unparseable or out of range, so the caller falls back to the default week
 * rather than reporting on a window nobody asked for.
 */
export function parseWeekIso(input: string | null | undefined): ReportWeek | null {
  const raw = input?.trim();
  if (!raw) return null;
  const m = WEEK_ISO_RE.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (!Number.isInteger(year) || year < 2000 || year > 2999) return null;
  if (!Number.isInteger(week) || week < 1 || week > 53) return null;

  const start = isoWeekStart(year, week);
  // Week 53 does not exist in every ISO year; isoWeekStart would silently roll
  // into week 1 of the next year. Round-trip to reject that instead of
  // reporting on a week the caller did not ask for.
  const parts = isoWeekParts(start);
  if (parts.year !== year || parts.week !== week) return null;

  return buildWeek(start);
}

/** Resolve the report window: an explicit `?week=` override, else the default. */
export function resolveReportWeek(weekIso?: string | null, now: Date = new Date()): ReportWeek {
  return parseWeekIso(weekIso) ?? mostRecentCompletedWeek(now);
}
