import type { Pool } from 'pg';

import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';
import {
  getMarketingScheduleForTenant,
  upsertMarketingSchedule,
  parseScheduleDay,
  parseScheduleHour,
  parseScheduleEnabled,
  isValidScheduleTimezone,
} from '@/backend/marketing/schedule-store';

/**
 * GET/PATCH /api/marketing/schedule
 *
 * Settings-hub cadence card (multi-brand workspaces Phase 1b, #803). Reuses
 * the single-writer helpers in backend/marketing/schedule-store.ts (Phase
 * 1a) so this route, the operator CLI, and onboarding auto-provisioning all
 * share one validated, COALESCE-preserve upsert — no re-derived SQL.
 *
 * Tenant id is resolved ONLY from tenantContext, never from the request body
 * or query string. Queries run strictly sequentially (no Promise.all around
 * the pg pool).
 */

type ScheduleDeps = {
  tenantContextLoader?: TenantContextLoader;
  db?: Pool;
};

type SchedulePatchBody = {
  day?: unknown;
  hour?: unknown;
  timezone?: unknown;
  enabled?: unknown;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readPatchBody(req: Request): Promise<SchedulePatchBody> {
  try {
    return (await req.json()) as SchedulePatchBody;
  } catch {
    return {};
  }
}

// A parsed optional field: omitted (not provided), provided+valid, or
// provided+invalid. Keeping "omitted" distinct from "invalid" is what lets a
// partial PATCH validate only the fields the caller actually sent.
type ParsedField<T> =
  | { provided: false }
  | { provided: true; valid: true; value: T }
  | { provided: true; valid: false };

function parseDayField(raw: unknown): ParsedField<number> {
  if (raw === undefined) return { provided: false };
  const normalized = typeof raw === 'number' ? String(raw) : raw;
  const parsed = parseScheduleDay(normalized as string | boolean | undefined);
  if (parsed === null) return { provided: true, valid: false };
  return { provided: true, valid: true, value: parsed };
}

function parseHourField(raw: unknown): ParsedField<number> {
  if (raw === undefined) return { provided: false };
  const normalized = typeof raw === 'number' ? String(raw) : raw;
  const parsed = parseScheduleHour(normalized as string | boolean | undefined);
  if (parsed === null) return { provided: true, valid: false };
  return { provided: true, valid: true, value: parsed };
}

function parseEnabledField(raw: unknown): ParsedField<boolean> {
  if (raw === undefined) return { provided: false };
  // parseScheduleEnabled only accepts string | boolean (it calls .trim() on
  // anything that isn't a boolean) — guard non-string/boolean/number shapes
  // (including an explicit `null`) before it ever reaches the validator.
  const normalized = typeof raw === 'number' ? String(raw) : raw;
  if (typeof normalized !== 'string' && typeof normalized !== 'boolean') {
    return { provided: true, valid: false };
  }
  const parsed = parseScheduleEnabled(normalized);
  if (parsed === null) return { provided: true, valid: false };
  return { provided: true, valid: true, value: parsed };
}

// Timezone is the one field with an explicit-clear semantic: `timezone: null`
// in the body is a deliberate "clear it" (timezoneProvided=true, value=null),
// distinct from omitting the key entirely (preserve existing value).
function parseTimezoneField(raw: unknown): ParsedField<string | null> {
  if (raw === undefined) return { provided: false };
  if (raw === null) return { provided: true, valid: true, value: null };
  if (typeof raw === 'string' && isValidScheduleTimezone(raw)) {
    return { provided: true, valid: true, value: raw };
  }
  return { provided: true, valid: false };
}

export async function handleGetMarketingSchedule(
  _req: Request,
  deps: ScheduleDeps = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(deps.tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const tenantId = Number(tenantResult.tenantContext.tenantId);

  const db = deps.db ?? pool;
  const schedule = await getMarketingScheduleForTenant(db, tenantId);
  return json({ schedule }, 200);
}

export async function handlePatchMarketingSchedule(
  req: Request,
  deps: ScheduleDeps = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(deps.tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantContext } = tenantResult;

  if (tenantContext.role !== 'tenant_admin') {
    return json({ error: 'forbidden' }, 403);
  }

  const body = await readPatchBody(req);

  const day = parseDayField(body.day);
  if (day.provided && !day.valid) {
    return json({ error: 'invalid_day' }, 400);
  }

  const hour = parseHourField(body.hour);
  if (hour.provided && !hour.valid) {
    return json({ error: 'invalid_hour' }, 400);
  }

  const timezone = parseTimezoneField(body.timezone);
  if (timezone.provided && !timezone.valid) {
    return json({ error: 'invalid_timezone' }, 400);
  }

  const enabled = parseEnabledField(body.enabled);
  if (enabled.provided && !enabled.valid) {
    return json({ error: 'invalid_enabled' }, 400);
  }

  // Tenant id ONLY from tenantContext — never from the body.
  const tenantId = Number(tenantContext.tenantId);

  const db = deps.db ?? pool;
  const schedule = await upsertMarketingSchedule(db, {
    tenantId,
    dayOfWeek: day.provided && day.valid ? day.value : null,
    hour: hour.provided && hour.valid ? hour.value : null,
    timezone: timezone.provided && timezone.valid ? timezone.value : null,
    timezoneProvided: timezone.provided,
    enabled: enabled.provided && enabled.valid ? enabled.value : null,
  });

  return json({ schedule }, 200);
}
