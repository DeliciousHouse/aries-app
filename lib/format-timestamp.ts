import { fromZonedTime, toZonedTime } from 'date-fns-tz';

/**
 * Shared timezone-aware timestamp helpers. Consolidates five previously
 * copy-pasted formatters (`components.tsx`, `dashboard-content.ts`,
 * `runtime-views.ts`, `view-models/calendar.ts`, `calendar-presenter.tsx`)
 * into one module with real DST-safe wall-time <-> UTC conversion.
 *
 * Display formatting is the easy part; the load-bearing pieces are
 * `wallTimeToUtc` (datetime-local -> UTC instant) and the calendar grid math
 * helpers (`tenantZoneDateKey`, `isTenantZoneToday`) which must agree on the
 * tenant business timezone so a post scheduled for 11pm tenant-time lands on
 * the right grid cell regardless of the operator's browser zone.
 */

/** Fixed fallback when a tenant has not set a business timezone (A4). */
export const DEFAULT_TENANT_TIMEZONE = 'America/New_York';

/**
 * DST policy for `wallTimeToUtc`, applied when an IANA zone makes a wall-clock
 * value ambiguous or nonexistent. Both branches resolve deterministically via
 * date-fns-tz `fromZonedTime`:
 *  - spring-forward GAP (e.g. 02:30 on a spring DST day, which never occurs):
 *    the wall value is resolved with the post-transition offset, yielding one
 *    deterministic instant. The gap input never re-renders as itself.
 *  - fall-back DUPLICATE (e.g. 01:30 on a fall DST day, which occurs twice):
 *    the EARLIER offset (the first occurrence) is chosen.
 * The policy is documented here and enforced by relying on `fromZonedTime`.
 */
export const DST_POLICY = {
  gap: 'post-transition-offset',
  duplicate: 'earlier',
} as const;

const IANA_ZONE_RE = /^[A-Za-z]+(?:[_-][A-Za-z]+)*(?:\/[A-Za-z0-9]+(?:[_+-][A-Za-z0-9]+)*)+$/;
const SPECIAL_ZONES = new Set(['UTC', 'GMT']);

/**
 * Validates an IANA timezone string. Uses the runtime's own Intl database as
 * the authority (a syntactic regex alone would accept `Foo/Bar`).
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (SPECIAL_ZONES.has(trimmed)) {
    return true;
  }
  if (!IANA_ZONE_RE.test(trimmed)) {
    return false;
  }
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/** Coerces an arbitrary value to a valid IANA zone or the fixed fallback. */
export function resolveTenantTimeZone(value: unknown): string {
  return isValidTimeZone(value) ? value.trim() : DEFAULT_TENANT_TIMEZONE;
}

// Per-timezone+options memoization. Constructing Intl.DateTimeFormat per call
// is measurable on a full month grid (Performance note in the plan).
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = `${timeZone}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
    formatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

function toDate(value: string | number | Date): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp);
}

/**
 * Renders a UTC instant as a wall-clock label in the tenant business zone.
 * Replaces the five `formatUtcTimestampLabel` clones. Returns the raw input
 * (stringified) when it cannot be parsed, matching the legacy fallback.
 */
export function formatInTenantZone(
  value: string | number | Date,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
  options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  },
): string {
  const date = toDate(value);
  if (!date) {
    return typeof value === 'string' ? value : String(value);
  }
  const zone = resolveTenantTimeZone(timeZone);
  return getFormatter(zone, options).format(date);
}

/**
 * Short abbreviation of the zone (e.g. `EST`), to suffix labels the way the
 * legacy formatters appended a hard-coded `UTC`.
 */
export function tenantZoneAbbreviation(
  value: string | number | Date,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): string {
  const date = toDate(value) ?? new Date();
  const zone = resolveTenantTimeZone(timeZone);
  const parts = getFormatter(zone, {
    timeZoneName: 'short',
    hour: 'numeric',
  }).formatToParts(date);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? zone;
}

/** Time-only label (24h) in the tenant zone — replaces `calendar-presenter`'s `formatTime`. */
export function formatTimeInTenantZone(
  value: string | number | Date,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): string {
  return formatInTenantZone(value, timeZone, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Renders a start/end UTC instant pair as an operator-facing publish window in
 * the tenant business timezone. This keeps dashboard range copy aligned with
 * the single tenant timezone source instead of exposing raw ISO/UTC strings.
 */
export function formatTenantDateRangeLabel(
  start: string | number | Date | null | undefined,
  end: string | number | Date | null | undefined,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): string {
  if (start === null || start === undefined || end === null || end === undefined) {
    return 'Dates not scheduled yet';
  }

  const startDate = toDate(start);
  const endDate = toDate(end);
  if (!startDate || !endDate) {
    return `${typeof start === 'string' ? start : String(start)} to ${typeof end === 'string' ? end : String(end)}`;
  }

  const zone = resolveTenantTimeZone(timeZone);
  const startLabel = `${formatInTenantZone(startDate, zone)} ${tenantZoneAbbreviation(startDate, zone)}`;
  const endLabel = `${formatInTenantZone(endDate, zone)} ${tenantZoneAbbreviation(endDate, zone)}`;
  return `${startLabel} to ${endLabel}`;
}

/**
 * Converts a `datetime-local` wall-clock value (no zone) to a UTC instant,
 * interpreting the wall time in the tenant business zone. DST gaps/duplicates
 * are resolved per `DST_POLICY` (date-fns-tz `fromZonedTime` default).
 *
 * Accepts `YYYY-MM-DDTHH:mm` or `YYYY-MM-DDTHH:mm:ss`. Returns null on a
 * malformed input.
 */
export function wallTimeToUtc(
  wallTime: string,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): Date | null {
  if (typeof wallTime !== 'string') {
    return null;
  }
  const trimmed = wallTime.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    return null;
  }
  const zone = resolveTenantTimeZone(timeZone);
  const utc = fromZonedTime(trimmed, zone);
  return Number.isFinite(utc.getTime()) ? utc : null;
}

/**
 * Converts a UTC instant to a `datetime-local`-shaped wall-clock string in the
 * tenant zone (the inverse of `wallTimeToUtc`, for pre-filling a drawer input).
 */
export function utcToWallTime(
  value: string | number | Date,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): string | null {
  const date = toDate(value);
  if (!date) {
    return null;
  }
  const zone = resolveTenantTimeZone(timeZone);
  const zoned = toZonedTime(date, zone);
  const pad = (input: number) => String(input).padStart(2, '0');
  return (
    `${zoned.getFullYear()}-${pad(zoned.getMonth() + 1)}-${pad(zoned.getDate())}` +
    `T${pad(zoned.getHours())}:${pad(zoned.getMinutes())}`
  );
}

/**
 * `YYYY-MM-DD` calendar-cell key for a UTC instant, computed in the tenant
 * zone. The calendar grid keys events by this so an 11pm tenant-zone post
 * lands on the correct cell for an operator browsing from any zone.
 */
export function tenantZoneDateKey(
  value: string | number | Date,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): string | null {
  const date = toDate(value);
  if (!date) {
    return null;
  }
  const zone = resolveTenantTimeZone(timeZone);
  const parts = getFormatter(zone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const year = lookup('year');
  const month = lookup('month');
  const day = lookup('day');
  if (!year || !month || !day) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

/**
 * The tenant-zone civil (year, month, day) that is `days` calendar days before
 * `now`'s tenant-zone civil date. Shared by the two period-window helpers below.
 * Subtracting on a UTC-anchored civil date keeps the arithmetic DST-agnostic
 * (we only ever manipulate the calendar fields, never an instant).
 */
function tenantZoneCivilDateNDaysAgo(
  days: number,
  zone: string,
  now: Date,
): { year: number; month: number; day: number } {
  const parts = tenantZoneParts(now, zone);
  const base = parts
    ? new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  base.setUTCDate(base.getUTCDate() - days);
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
}

/**
 * S2-3 / AA-94 — the UTC instant of tenant-zone midnight, `days` tenant-days
 * before `now`. This is the period-window lower bound for a `timestamptz` column
 * (e.g. `received_at`, `published_at`, `created_at`): `col >= $1` then means
 * "on or after midnight, `days` days ago, in the tenant's own timezone" for every
 * section consistently — replacing the old per-builder `setUTCHours(0,0,0,0)` UTC
 * window that made sections disagree about which day an event fell on.
 */
export function tenantZonePeriodStart(
  days: number,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
  now: Date = new Date(),
): Date {
  const zone = resolveTenantTimeZone(timeZone);
  const { year, month, day } = tenantZoneCivilDateNDaysAgo(days, zone, now);
  const pad = (input: number) => String(input).padStart(2, '0');
  const wall = `${year}-${pad(month)}-${pad(day)}T00:00:00`;
  const utc = fromZonedTime(wall, zone);
  return Number.isFinite(utc.getTime()) ? utc : now;
}

/**
 * S2-3 / AA-94 — the `YYYY-MM-DD` tenant-zone calendar date, `days` tenant-days
 * before `now`. This is the period-window lower bound for the bare `DATE` columns
 * on the daily metric tables (`insights_account_metrics_daily.date`), compared as
 * `date >= $1::date`. A bare DATE has no time-of-day, so it must be bounded by a
 * calendar date, NOT the instant from `tenantZonePeriodStart` (comparing a DATE to
 * a timestamptz instant is session-timezone-dependent and off-by-one at the
 * boundary). The per-row day attribution on those tables remains write-side-bound.
 */
export function tenantZonePeriodStartDateKey(
  days: number,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
  now: Date = new Date(),
): string {
  const zone = resolveTenantTimeZone(timeZone);
  const { year, month, day } = tenantZoneCivilDateNDaysAgo(days, zone, now);
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** True when a UTC instant falls on the current calendar day in the tenant zone. */
export function isTenantZoneToday(
  value: string | number | Date,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
  now: Date = new Date(),
): boolean {
  const key = tenantZoneDateKey(value, timeZone);
  return key !== null && key === tenantZoneDateKey(now, timeZone);
}

/**
 * The civil (year, month, day, hour, minute) breakdown of a UTC instant in the
 * tenant zone — used by the calendar grid to build a tenant-zone `Date` for
 * week/month boundary math without browser-local drift.
 */
export function tenantZoneParts(
  value: string | number | Date,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const date = toDate(value);
  if (!date) {
    return null;
  }
  const zone = resolveTenantTimeZone(timeZone);
  const parts = getFormatter(zone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '', 10);
  const year = lookup('year');
  const month = lookup('month');
  const day = lookup('day');
  let hour = lookup('hour');
  const minute = lookup('minute');
  // Intl can emit hour `24` for midnight under hour12:false.
  if (hour === 24) {
    hour = 0;
  }
  if ([year, month, day, hour, minute].some((part) => !Number.isFinite(part))) {
    return null;
  }
  return { year, month, day, hour, minute };
}
