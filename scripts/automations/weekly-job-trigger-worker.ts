/**
 * Weekly-job trigger worker — standing process that starts a
 * weekly_social_content job for each opted-in tenant on its configured cadence.
 *
 * Gated by ARIES_WEEKLY_TRIGGER_ENABLED (default OFF). Mirrors the
 * scheduled-posts-worker: a single-replica docker-compose service, self-
 * scheduling on an interval, hitting the in-network app over
 * http://aries-app:3000. It owns ONLY the cadence + dedup; job-start is
 * delegated to POST /api/internal/marketing/weekly-trigger (which submits to
 * Hermes inside the app process).
 *
 * Dedup is an atomic conditional-claim UPDATE on marketing_schedule, NOT a
 * read-then-write: two ticks (or two containers) that both think a tenant is due
 * race on the UPDATE, and only the one whose WHERE still matches
 * (last_triggered_at < window-start) claims the row. One job per tenant per
 * cadence window.
 *
 * Submit failure is LOUD and does not lose the week: on an error response the
 * claim is reverted to the prior last_triggered_at so the next tick retries, and
 * a warning is logged. A deliberate skip (no Meta / stale brand kit / incomplete
 * profile) keeps the claim — it is a decision, not a failure — and is logged so
 * an operator can act, without re-triggering every tick.
 */
import 'dotenv/config';

import pg from 'pg';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { wallTimeToUtc, DEFAULT_TENANT_TIMEZONE } from '@/lib/format-timestamp';
import { loadTenantTimezoneOrFallback } from '@/backend/tenant/business-profile';
import { parsePoolMax, WORKER_POOL_MAX } from '@/lib/db-pool-config';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function weeklyTriggerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.ARIES_WEEKLY_TRIGGER_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function resolveIntervalMs(): number {
  const raw = process.env.ARIES_WEEKLY_TRIGGER_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

function resolveAppBaseUrl(): string {
  return (process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || '').replace(/\/$/, '');
}

function resolveInternalSecret(): string {
  return process.env.INTERNAL_API_SECRET || '';
}

// ---------------------------------------------------------------------------
// Timezone math (pure, exported for tests)
// ---------------------------------------------------------------------------

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

type TenantLocalParts = { year: number; month: number; day: number; weekday: number; hour: number };

/** Decompose a UTC instant into the tenant's local calendar parts. */
export function tenantLocalParts(now: Date, tz: string): TenantLocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    hour: Number.parseInt(get('hour'), 10),
  };
}

/**
 * The UTC instant of the most recent (dayOfWeek, hour:00) slot at or before
 * `now`, in the tenant's IANA timezone. The cadence "window start": a tenant is
 * due when its last_triggered_at is before this instant (i.e. it has not been
 * triggered since its slot came around this week). Returns null if the timezone
 * is unusable.
 */
export function mostRecentSlotUtc(
  now: Date,
  tz: string,
  dayOfWeek: number,
  hour: number,
): Date | null {
  const local = tenantLocalParts(now, tz);
  // Days to step back to reach the target weekday. If today IS the target day
  // but the hour has not arrived yet, the slot is last week's, not today's.
  let delta = (local.weekday - dayOfWeek + 7) % 7;
  if (delta === 0 && local.hour < hour) delta = 7;

  // Calendar subtraction via UTC date arithmetic (handles month/year rollover);
  // we only use it to derive Y-M-D, never as an instant.
  const slotForDelta = (d: number): Date | null => {
    const stepped = new Date(Date.UTC(local.year, local.month - 1, local.day - d));
    const wall = `${stepped.getUTCFullYear()}-${pad2(stepped.getUTCMonth() + 1)}-${pad2(stepped.getUTCDate())}T${pad2(hour)}:00`;
    return wallTimeToUtc(wall, tz);
  };

  let slot = slotForDelta(delta);
  // DST fall-back guard: when `hour` is the ambiguous repeated hour (e.g. 1 in
  // US zones, 2 in Sydney), date-fns-tz resolves the wall time to the LATER
  // (post-transition) occurrence, which can land slightly AFTER `now`. A future
  // windowStart is poison: the claim sets last_triggered_at = now() which stays
  // < windowStart, so every subsequent tick re-satisfies the due predicate and
  // re-triggers (a duplicate-job storm for ~1h). The slot recurs weekly, so
  // stepping back 7 days is always strictly in the past.
  if (slot && slot.getTime() > now.getTime()) {
    slot = slotForDelta(delta + 7);
  }
  return slot;
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

export function buildPool(): pg.Pool {
  return new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: parsePoolMax(process.env.DB_POOL_MAX, WORKER_POOL_MAX),
  });
}

export const ENABLED_ROWS_SQL = `SELECT tenant_id, day_of_week, hour, timezone, last_triggered_at
     FROM marketing_schedule
    WHERE enabled`;

// Atomic conditional claim. The `prev` CTE captures the pre-update
// last_triggered_at so a failed submit can revert exactly. The row is claimed
// (and RETURNs) only if it is still due under the lock — this is the dedup.
export const CLAIM_SQL = `WITH prev AS (
       SELECT tenant_id, last_triggered_at AS prior
         FROM marketing_schedule
        WHERE tenant_id = $1
     )
     UPDATE marketing_schedule m
        SET last_triggered_at = now(),
            last_attempt_at   = now(),
            updated_at        = now()
       FROM prev
      WHERE m.tenant_id = prev.tenant_id
        AND m.enabled
        AND (m.last_triggered_at IS NULL OR m.last_triggered_at < $2)
      RETURNING prev.prior AS prior_last_triggered_at`;

export const MARK_SUCCESS_SQL = `UPDATE marketing_schedule
        SET last_success_at = now(), updated_at = now()
      WHERE tenant_id = $1`;

export const REVERT_CLAIM_SQL = `UPDATE marketing_schedule
        SET last_triggered_at = $2, updated_at = now()
      WHERE tenant_id = $1`;

type EnabledRow = {
  tenant_id: number;
  day_of_week: number;
  hour: number;
  timezone: string | null;
  last_triggered_at: string | Date | null;
};

function resolveTenantTz(row: EnabledRow): string {
  const explicit = typeof row.timezone === 'string' ? row.timezone.trim() : '';
  if (explicit) return explicit;
  try {
    return loadTenantTimezoneOrFallback(String(row.tenant_id));
  } catch {
    return DEFAULT_TENANT_TIMEZONE;
  }
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

type TriggerResponse = { status?: string; reason?: string; jobId?: string };

async function postTrigger(
  baseUrl: string,
  secret: string,
  tenantId: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; body: TriggerResponse; httpStatus: number }> {
  const res = await fetchImpl(`${baseUrl}/api/internal/marketing/weekly-trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ tenant_id: tenantId }),
  });
  let body: TriggerResponse = {};
  try {
    body = (await res.json()) as TriggerResponse;
  } catch {
    body = {};
  }
  return { ok: res.ok, body, httpStatus: res.status };
}

export type WeeklyTriggerTickReport = {
  scanned: number;
  due: number;
  claimed: number;
  started: number;
  skipped: number;
  failed: number;
};

/**
 * One scan pass. Exported so a test can drive a single tick against a real (or
 * fake) pool and fetch. `now` and `fetchImpl` are injectable for determinism.
 */
export async function tick(
  pool: Queryable,
  opts: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<WeeklyTriggerTickReport> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = resolveAppBaseUrl();
  const secret = resolveInternalSecret();
  const report: WeeklyTriggerTickReport = { scanned: 0, due: 0, claimed: 0, started: 0, skipped: 0, failed: 0 };

  if (!baseUrl) {
    console.error('[weekly-trigger-worker] APP_BASE_URL not set; skipping tick');
    return report;
  }

  const enabled = await pool.query(ENABLED_ROWS_SQL);
  const rows = (enabled.rows as EnabledRow[]) ?? [];
  report.scanned = rows.length;

  for (const row of rows) {
    const tenantId = String(row.tenant_id);
    const tz = resolveTenantTz(row);
    const windowStart = mostRecentSlotUtc(now, tz, row.day_of_week, row.hour);
    if (!windowStart) {
      console.warn('[weekly-trigger-worker] unusable timezone; skipping', { tenantId, tz });
      continue;
    }

    const prior = row.last_triggered_at ? new Date(row.last_triggered_at) : null;
    const isDue = prior === null || prior.getTime() < windowStart.getTime();
    if (!isDue) continue;
    report.due += 1;

    // Atomic claim. Only a returned row was actually claimed (won the race).
    const claim = await pool.query(CLAIM_SQL, [row.tenant_id, windowStart.toISOString()]);
    if (!claim.rowCount) continue;
    report.claimed += 1;
    const priorClaim = (claim.rows[0] as { prior_last_triggered_at: string | Date | null })?.prior_last_triggered_at ?? null;

    try {
      const { ok, body, httpStatus } = await postTrigger(baseUrl, secret, tenantId, fetchImpl);
      if (!ok) {
        // Loud failure: revert the claim so the next tick retries this tenant.
        await pool.query(REVERT_CLAIM_SQL, [row.tenant_id, priorClaim]);
        report.failed += 1;
        console.error('[weekly-trigger-worker] trigger failed — reverted claim, will retry', {
          tenantId, httpStatus, reason: body.reason ?? body.status ?? 'unknown',
        });
        continue;
      }
      if (body.status === 'started' || body.status === 'needs_connection') {
        await pool.query(MARK_SUCCESS_SQL, [row.tenant_id]);
        report.started += 1;
        console.log('[weekly-trigger-worker] started weekly job', {
          tenantId, status: body.status, jobId: body.jobId ?? null,
        });
      } else {
        // Deliberate skip (gate). Keep the claim (no retry this window); surface.
        report.skipped += 1;
        console.warn('[weekly-trigger-worker] tenant skipped by a gate', {
          tenantId, reason: body.reason ?? 'unknown',
        });
      }
    } catch (err) {
      await pool.query(REVERT_CLAIM_SQL, [row.tenant_id, priorClaim]);
      report.failed += 1;
      console.error('[weekly-trigger-worker] trigger threw — reverted claim, will retry', {
        tenantId, error: (err as Error)?.message ?? String(err),
      });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let running = false;
let intervalHandle: NodeJS.Timeout | null = null;

async function tickSafe(pool: pg.Pool): Promise<void> {
  if (running) {
    console.warn('[weekly-trigger-worker] previous tick still running; skipping');
    return;
  }
  running = true;
  try {
    const report = await tick(pool);
    if (report.claimed > 0 || report.failed > 0) {
      console.log(`[weekly-trigger-worker] summary ${JSON.stringify(report)}`);
    }
  } catch (error) {
    console.error('[weekly-trigger-worker] tick error', error);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  if (!weeklyTriggerEnabled()) {
    // IDLE, do not exit. This runs as a docker-compose service with
    // `restart: unless-stopped`; a clean exit(0) makes Docker restart-loop the
    // container (slow, but a perpetually-restarting service trips monitoring and
    // spams logs). Staying alive doing nothing leaves the container cleanly "up"
    // when the flag is off, while still responding to `docker stop`. Set the
    // flag and restart the service to enable.
    console.log('[weekly-trigger-worker] ARIES_WEEKLY_TRIGGER_ENABLED is off; idling (no work). Set the flag and restart to enable.');
    if (process.env.ARIES_WEEKLY_TRIGGER_RUN_ONCE?.trim() === '1') {
      process.exit(0); // one-shot / smoke invocations must not hang
    }
    const idle = setInterval(() => {}, 1 << 30); // ~12 days; just keeps the event loop alive
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        clearInterval(idle);
        process.exit(0);
      });
    }
    return;
  }

  const intervalMs = resolveIntervalMs();
  const pool = buildPool();
  console.log(`[weekly-trigger-worker] starting; interval=${intervalMs}ms`);

  await tickSafe(pool);

  if (process.env.ARIES_WEEKLY_TRIGGER_RUN_ONCE?.trim() === '1') {
    await pool.end();
    process.exit(0);
  }

  intervalHandle = setInterval(() => void tickSafe(pool), intervalMs);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      if (intervalHandle) clearInterval(intervalHandle);
      await pool.end().catch(() => {});
      process.exit(0);
    });
  }
}

// Only auto-start when run directly; importing this module (e.g. from a unit
// test for mostRecentSlotUtc / tick) must not spin up the worker loop.
const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  void main();
}
