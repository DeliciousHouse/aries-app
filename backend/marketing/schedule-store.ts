/**
 * `marketing_schedule` — single writer.
 *
 * Historically the only writer of this table was the operator CLI
 * (`scripts/marketing/upsert-marketing-schedule.ts`), which validates
 * day/hour/timezone/enabled before writing so a typo can't silently misfire a
 * tenant's whole cadence (the CEO review's "6-month ops regret"). This module
 * lifts those validators + the exact upsert SQL out of the CLI so a second
 * caller — onboarding auto-provisioning (multi-brand workspaces Phase 1a) —
 * can reuse them verbatim instead of re-deriving the SQL/validation and
 * risking drift.
 *
 * `db` is a structural type (`.query(text, params)`), so both `pg.Pool` and
 * `pg.PoolClient` satisfy it. This module NEVER opens its own connection —
 * callers own connection lifecycle (a borrowed onboarding client, the CLI's
 * own pool, a future route handler's tenant-scoped client, etc).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ScheduleQueryable = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type MarketingScheduleRow = {
  tenant_id: number;
  cadence: string;
  day_of_week: number;
  hour: number;
  timezone: string | null;
  enabled: boolean;
  last_triggered_at?: unknown;
  last_attempt_at?: unknown;
  last_success_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

// ---------------------------------------------------------------------------
// Validators — moved verbatim from scripts/marketing/upsert-marketing-schedule.ts
// ---------------------------------------------------------------------------

const DAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

export function parseScheduleDay(raw: string | boolean | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  if (/^[0-6]$/.test(t)) return Number.parseInt(t, 10);
  return DAY_NAMES[t] ?? null;
}

export function parseScheduleHour(raw: string | boolean | undefined): number | null {
  if (typeof raw !== 'string') return null;
  if (!/^\d{1,2}$/.test(raw.trim())) return null;
  const h = Number.parseInt(raw.trim(), 10);
  return h >= 0 && h <= 23 ? h : null;
}

export function isValidScheduleTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseScheduleEnabled(raw: string | boolean | undefined): boolean | null {
  if (raw === undefined) return null;
  if (typeof raw === 'boolean') return raw;
  const t = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export type UpsertMarketingScheduleInput = {
  tenantId: number;
  /** null = omitted (preserve existing value / table default on insert). */
  dayOfWeek: number | null;
  /** null = omitted (preserve existing value / table default on insert). */
  hour: number | null;
  /** null = omitted (preserve existing value) OR an explicit clear when timezoneProvided is true. */
  timezone: string | null;
  /**
   * Distinguishes "timezone omitted, preserve existing" from "timezone
   * explicitly provided (possibly null, to clear it)" — a plain `timezone:
   * null` is ambiguous on its own, exactly why the CLI carries a separate
   * `tzProvided` flag over the wire as $6.
   */
  timezoneProvided: boolean;
  /** null = omitted (preserve existing value / table default on insert). */
  enabled: boolean | null;
};

/**
 * The exact COALESCE-preserve upsert from
 * scripts/marketing/upsert-marketing-schedule.ts: an omitted arg (null
 * param) preserves the stored value on UPDATE; table defaults apply only to
 * brand-new INSERTs. Used by both the CLI and the (future) settings PATCH
 * route (1b) so both share one behavior-pinned SQL statement.
 */
export async function upsertMarketingSchedule(
  db: ScheduleQueryable,
  input: UpsertMarketingScheduleInput,
): Promise<MarketingScheduleRow> {
  const res = await db.query(
    `INSERT INTO marketing_schedule (tenant_id, cadence, day_of_week, hour, timezone, enabled)
     VALUES ($1, 'weekly', COALESCE($2, 1), COALESCE($3, 9), $4, COALESCE($5, false))
     ON CONFLICT (tenant_id) DO UPDATE
       SET day_of_week = COALESCE($2, marketing_schedule.day_of_week),
           hour        = COALESCE($3, marketing_schedule.hour),
           timezone    = CASE WHEN $6 THEN $4 ELSE marketing_schedule.timezone END,
           enabled     = COALESCE($5, marketing_schedule.enabled),
           updated_at  = now()
     RETURNING tenant_id, day_of_week, hour, timezone, enabled`,
    [input.tenantId, input.dayOfWeek, input.hour, input.timezone, input.enabled, input.timezoneProvided],
  );
  return res.rows[0] as MarketingScheduleRow;
}

export type ProvisionDefaultMarketingScheduleInput = {
  tenantId: number;
  timezone: string | null;
  dayOfWeek?: number;
  hour?: number;
  enabled?: boolean;
};

/**
 * Onboarding auto-provision (multi-brand workspaces Phase 1a): seed a
 * default weekly cadence row for a newly-materialized tenant so a
 * cadence-settings card (1b) has something to render and the weekly trigger
 * worker (when enabled) has a row to pick up. `ON CONFLICT DO NOTHING` — this
 * NEVER clobbers an existing row (e.g. a re-materialized/reused tenant, or a
 * re-run of onboarding), so it is safe to call unconditionally and
 * repeatedly. Returns whether a row was actually created.
 */
export async function provisionDefaultMarketingSchedule(
  db: ScheduleQueryable,
  input: ProvisionDefaultMarketingScheduleInput,
): Promise<{ created: boolean }> {
  const dayOfWeek = input.dayOfWeek ?? 1;
  const hour = input.hour ?? 9;
  const enabled = input.enabled ?? true;

  const res = await db.query(
    `INSERT INTO marketing_schedule (tenant_id, cadence, day_of_week, hour, timezone, enabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [input.tenantId, 'weekly', dayOfWeek, hour, input.timezone, enabled],
  );
  return { created: (res.rowCount ?? 0) > 0 };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export async function getMarketingScheduleForTenant(
  db: ScheduleQueryable,
  tenantId: number,
): Promise<MarketingScheduleRow | null> {
  const res = await db.query(
    `SELECT tenant_id, cadence, day_of_week, hour, timezone, enabled,
            last_triggered_at, last_attempt_at, last_success_at
       FROM marketing_schedule
      WHERE tenant_id = $1
      LIMIT 1`,
    [tenantId],
  );
  return (res.rows[0] as MarketingScheduleRow | undefined) ?? null;
}

export async function listMarketingSchedules(db: ScheduleQueryable): Promise<MarketingScheduleRow[]> {
  const res = await db.query(
    `SELECT tenant_id, cadence, day_of_week, hour, timezone, enabled,
            last_triggered_at, last_success_at
       FROM marketing_schedule
      ORDER BY tenant_id`,
    [],
  );
  return res.rows as MarketingScheduleRow[];
}
