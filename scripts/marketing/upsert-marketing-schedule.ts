/**
 * Minimal day/hour/tz control for the weekly trigger — the MVP alternative to
 * hand-editing marketing_schedule with raw SQL (which the CEO review flagged as
 * a 6-month ops regret: a typo silently mis-fires a customer's whole cadence).
 *
 * Upserts one tenant's weekly cadence row. Validates day/hour/timezone before
 * writing so a bad value is rejected loudly instead of misfiring silently.
 *
 * Usage:
 *   tsx scripts/marketing/upsert-marketing-schedule.ts \
 *     --tenant 15 --day mon --hour 9 --tz America/New_York --enabled true
 *
 *   # disable a tenant's cadence
 *   tsx scripts/marketing/upsert-marketing-schedule.ts --tenant 15 --enabled false
 *
 *   # list current schedules
 *   tsx scripts/marketing/upsert-marketing-schedule.ts --list
 *
 * --day accepts 0-6 (0=Sun) or sun/mon/tue/wed/thu/fri/sat.
 * --hour accepts 0-23 (tenant-local). --tz is an IANA name (validated).
 */
import 'dotenv/config';

import pg from 'pg';

const DAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseDay(raw: string | boolean | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  if (/^[0-6]$/.test(t)) return Number.parseInt(t, 10);
  return DAY_NAMES[t] ?? null;
}

function parseHour(raw: string | boolean | undefined): number | null {
  if (typeof raw !== 'string') return null;
  if (!/^\d{1,2}$/.test(raw.trim())) return null;
  const h = Number.parseInt(raw.trim(), 10);
  return h >= 0 && h <= 23 ? h : null;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseEnabled(raw: string | boolean | undefined): boolean | null {
  if (raw === undefined) return null;
  if (typeof raw === 'boolean') return raw;
  const t = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  return null;
}

function buildPool(): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: 2,
  });
}

async function list(pool: pg.Pool): Promise<void> {
  const res = await pool.query(
    `SELECT tenant_id, cadence, day_of_week, hour, timezone, enabled,
            last_triggered_at, last_success_at
       FROM marketing_schedule
      ORDER BY tenant_id`,
  );
  if (res.rowCount === 0) {
    console.log('(no marketing_schedule rows)');
    return;
  }
  console.table(res.rows);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = buildPool();
  try {
    if (args.list) {
      await list(pool);
      return;
    }

    const tenantRaw = args.tenant;
    const tenantId = typeof tenantRaw === 'string' ? Number.parseInt(tenantRaw, 10) : NaN;
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      throw new Error('--tenant <id> is required (positive integer)');
    }

    // CRITICAL: an OMITTED arg must PRESERVE the stored value on update, never
    // reset it to a default. A blind write-without-read here is the exact
    // "6-month ops regret" this CLI exists to prevent: `--tenant 15 --day fri`
    // (no --enabled) would silently disable the tenant; `--tenant 15 --enabled
    // true` (no --day/--hour/--tz) would silently reset its whole cadence to
    // Mon/09:00/null. So omitted args map to NULL params and the UPDATE COALESCEs
    // them against the existing row; table defaults apply only to brand-new INSERTs.
    const day = args.day !== undefined ? parseDay(args.day) : null;
    if (args.day !== undefined && day === null) throw new Error(`invalid --day: ${String(args.day)} (use 0-6 or sun..sat)`);

    const hour = args.hour !== undefined ? parseHour(args.hour) : null;
    if (args.hour !== undefined && hour === null) throw new Error(`invalid --hour: ${String(args.hour)} (use 0-23)`);

    // timezone NULL is itself meaningful (clear → use tenant business tz), so a
    // separate "provided" flag distinguishes "omit, preserve" from "set".
    const tzProvided = typeof args.tz === 'string';
    const tz = tzProvided ? (args.tz as string).trim() : null;
    if (tzProvided && tz && !isValidTimezone(tz)) {
      throw new Error(`invalid --tz: ${tz} (use an IANA name like America/New_York)`);
    }

    const enabled = parseEnabled(args.enabled); // null when omitted → preserved
    if (args.enabled !== undefined && enabled === null) {
      throw new Error(`invalid --enabled: ${String(args.enabled)} (use true/false)`);
    }

    const res = await pool.query(
      `INSERT INTO marketing_schedule (tenant_id, cadence, day_of_week, hour, timezone, enabled)
       VALUES ($1, 'weekly', COALESCE($2, 1), COALESCE($3, 9), $4, COALESCE($5, false))
       ON CONFLICT (tenant_id) DO UPDATE
         SET day_of_week = COALESCE($2, marketing_schedule.day_of_week),
             hour        = COALESCE($3, marketing_schedule.hour),
             timezone    = CASE WHEN $6 THEN $4 ELSE marketing_schedule.timezone END,
             enabled     = COALESCE($5, marketing_schedule.enabled),
             updated_at  = now()
       RETURNING tenant_id, day_of_week, hour, timezone, enabled`,
      [tenantId, day, hour, tz, enabled, tzProvided],
    );
    console.log('upserted marketing_schedule:', res.rows[0]);
  } finally {
    await pool.end().catch(() => {});
  }
}

void main().catch((err) => {
  console.error(`[upsert-marketing-schedule] ${(err as Error)?.message ?? String(err)}`);
  process.exit(1);
});
