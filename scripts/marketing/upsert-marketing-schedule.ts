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
 *
 * This is a thin CLI wrapper — argv parsing, its own pool, and process-exit
 * handling live here. Validation + the actual upsert SQL live in
 * backend/marketing/schedule-store.ts (the single writer), shared with the
 * onboarding auto-provision hook and the (future) settings PATCH route.
 */
import 'dotenv/config';

import pg from 'pg';

import {
  isValidScheduleTimezone,
  listMarketingSchedules,
  parseScheduleDay,
  parseScheduleEnabled,
  parseScheduleHour,
  upsertMarketingSchedule,
} from '@/backend/marketing/schedule-store';

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
  const rows = await listMarketingSchedules(pool);
  if (rows.length === 0) {
    console.log('(no marketing_schedule rows)');
    return;
  }
  console.table(rows);
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
    const day = args.day !== undefined ? parseScheduleDay(args.day) : null;
    if (args.day !== undefined && day === null) throw new Error(`invalid --day: ${String(args.day)} (use 0-6 or sun..sat)`);

    const hour = args.hour !== undefined ? parseScheduleHour(args.hour) : null;
    if (args.hour !== undefined && hour === null) throw new Error(`invalid --hour: ${String(args.hour)} (use 0-23)`);

    // timezone NULL is itself meaningful (clear → use tenant business tz), so a
    // separate "provided" flag distinguishes "omit, preserve" from "set".
    const tzProvided = typeof args.tz === 'string';
    const tz = tzProvided ? (args.tz as string).trim() : null;
    if (tzProvided && tz && !isValidScheduleTimezone(tz)) {
      throw new Error(`invalid --tz: ${tz} (use an IANA name like America/New_York)`);
    }

    const enabled = parseScheduleEnabled(args.enabled); // null when omitted → preserved
    if (args.enabled !== undefined && enabled === null) {
      throw new Error(`invalid --enabled: ${String(args.enabled)} (use true/false)`);
    }

    const row = await upsertMarketingSchedule(pool, {
      tenantId,
      dayOfWeek: day,
      hour,
      timezone: tz,
      timezoneProvided: tzProvided,
      enabled,
    });
    console.log('upserted marketing_schedule:', row);
  } finally {
    await pool.end().catch(() => {});
  }
}

void main().catch((err) => {
  console.error(`[upsert-marketing-schedule] ${(err as Error)?.message ?? String(err)}`);
  process.exit(1);
});
