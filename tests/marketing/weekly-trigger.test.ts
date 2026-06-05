/**
 * Piece B — weekly trigger worker + the shared trigger helper.
 *
 * Covers, with injected fakes (no live DB):
 *   - the timezone "most recent slot" math (DST-aware, day/hour boundaries);
 *   - the ARIES_WEEKLY_TRIGGER_ENABLED flag parser;
 *   - the trigger helper's gates (channel / brand-kit / profile) + started path;
 *   - the worker tick: due detection, atomic-claim respected, success marks
 *     success, failure reverts the claim (loud, retry next tick), lost race is a
 *     no-op.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/weekly-trigger.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { TenantBrandKit } from '../../backend/marketing/brand-kit';

// ---------------------------------------------------------------------------
// Timezone math
// ---------------------------------------------------------------------------

test('mostRecentSlotUtc: a past weekday slot resolves to the correct UTC instant (EDT)', async () => {
  const { mostRecentSlotUtc } = await import('../../scripts/automations/weekly-job-trigger-worker');
  const now = new Date('2026-06-04T12:00:00.000Z'); // Thursday, 08:00 America/New_York (EDT)
  // Most recent Monday 09:00 ET at/before now = Mon 2026-06-01 09:00 ET = 13:00 UTC.
  const slot = mostRecentSlotUtc(now, 'America/New_York', 1, 9);
  assert.equal(slot?.toISOString(), '2026-06-01T13:00:00.000Z');
});

test('mostRecentSlotUtc: same day but hour not yet arrived → previous week', async () => {
  const { mostRecentSlotUtc } = await import('../../scripts/automations/weekly-job-trigger-worker');
  const now = new Date('2026-06-04T12:00:00.000Z'); // Thursday 08:00 ET
  // Thursday hour=9, but local time is 08:00 < 09:00 → this week's slot hasn't
  // arrived; the most recent slot is last Thursday (2026-05-28) 09:00 ET = 13:00 UTC.
  const slot = mostRecentSlotUtc(now, 'America/New_York', 4, 9);
  assert.equal(slot?.toISOString(), '2026-05-28T13:00:00.000Z');
});

test('mostRecentSlotUtc: same day and hour already passed → today', async () => {
  const { mostRecentSlotUtc } = await import('../../scripts/automations/weekly-job-trigger-worker');
  const now = new Date('2026-06-04T12:00:00.000Z'); // Thursday 08:00 ET
  // Thursday hour=7, local time 08:00 >= 07:00 → today's slot = 2026-06-04 07:00 ET = 11:00 UTC.
  const slot = mostRecentSlotUtc(now, 'America/New_York', 4, 7);
  assert.equal(slot?.toISOString(), '2026-06-04T11:00:00.000Z');
});

test('mostRecentSlotUtc: timezone is respected (UTC vs NY differ by the offset)', async () => {
  const { mostRecentSlotUtc } = await import('../../scripts/automations/weekly-job-trigger-worker');
  const now = new Date('2026-06-04T12:00:00.000Z');
  const utcSlot = mostRecentSlotUtc(now, 'UTC', 1, 9); // Mon 09:00 UTC = 2026-06-01T09:00Z
  assert.equal(utcSlot?.toISOString(), '2026-06-01T09:00:00.000Z');
});

test('mostRecentSlotUtc: DST fall-back ambiguous hour never returns a FUTURE slot (dup-trigger guard)', async () => {
  const { mostRecentSlotUtc } = await import('../../scripts/automations/weekly-job-trigger-worker');
  // Each case configures the tenant's hour AT the DST fall-back transition hour,
  // where the wall time is ambiguous and date-fns-tz resolves to the LATER
  // occurrence — which can be after `now`. The contract is "most recent slot AT
  // OR BEFORE now"; a future slot would make last_triggered_at < windowStart
  // forever → duplicate-trigger storm. The clamp must keep slot <= now.
  const cases = [
    // Sydney leaves DST 2026-04-05 03:00→02:00; hour=2 is the repeated hour.
    { now: '2026-04-04T15:45:00.000Z', tz: 'Australia/Sydney', day: 0, hour: 2 },
    // US leaves DST 2026-11-01 02:00→01:00; hour=1 is the repeated hour. 05:30Z
    // is the first 01:30 (EDT) — inside the ambiguous window.
    { now: '2026-11-01T05:30:00.000Z', tz: 'America/New_York', day: 0, hour: 1 },
  ];
  for (const c of cases) {
    const now = new Date(c.now);
    const slot = mostRecentSlotUtc(now, c.tz, c.day, c.hour);
    assert.ok(slot, `slot should resolve for ${c.tz}`);
    assert.ok(
      slot!.getTime() <= now.getTime(),
      `${c.tz} hour=${c.hour}: slot ${slot!.toISOString()} must not be after now ${c.now}`,
    );
    // And it must be a real recent slot (within ~8 days back), not arbitrarily old.
    assert.ok(now.getTime() - slot!.getTime() <= 8 * 24 * 60 * 60 * 1000);
  }
});

test('tenantLocalParts: decomposes an instant into tenant-local calendar parts', async () => {
  const { tenantLocalParts } = await import('../../scripts/automations/weekly-job-trigger-worker');
  const parts = tenantLocalParts(new Date('2026-06-04T12:00:00.000Z'), 'America/New_York');
  assert.deepEqual(parts, { year: 2026, month: 6, day: 4, weekday: 4 /* Thu */, hour: 8 });
});

// ---------------------------------------------------------------------------
// Flag parser
// ---------------------------------------------------------------------------

test('weeklyTriggerEnabled: truthy on / off matrix; default OFF', async () => {
  const { weeklyTriggerEnabled } = await import('../../scripts/automations/weekly-job-trigger-worker');
  assert.equal(weeklyTriggerEnabled({} as NodeJS.ProcessEnv), false);
  for (const v of ['1', 'true', 'YES', ' on ']) {
    assert.equal(weeklyTriggerEnabled({ ARIES_WEEKLY_TRIGGER_ENABLED: v } as unknown as NodeJS.ProcessEnv), true, v);
  }
  for (const v of ['', '0', 'false', 'no', 'nope']) {
    assert.equal(weeklyTriggerEnabled({ ARIES_WEEKLY_TRIGGER_ENABLED: v } as unknown as NodeJS.ProcessEnv), false, v);
  }
});

// ---------------------------------------------------------------------------
// Trigger helper gates
// ---------------------------------------------------------------------------

function makeKit(overrides: Partial<TenantBrandKit> = {}): TenantBrandKit {
  return {
    tenant_id: '15', source_url: 'https://brand.example', canonical_url: 'https://brand.example',
    brand_name: 'Brand', logo_urls: [], colors: { primary: null, secondary: null, accent: null, palette: [] },
    font_families: [], external_links: [], extracted_at: new Date().toISOString(),
    brand_voice_summary: 'clear', offer_summary: null,
    positioning: 'Premium', audience: 'Founders', tone_of_voice: 'Bold', style_vibe: 'Quiet Luxury',
    ...overrides,
  };
}

const FRESH_NOW = Date.parse('2026-06-04T12:00:00.000Z');

const okDefaults = async () => ({ websiteUrl: 'https://brand.example', businessType: 'coaching' });

test('helper gate 1: no Meta connection → skipped(no_channel), job NOT started', async () => {
  const { triggerWeeklyJobForTenant } = await import('../../backend/marketing/weekly-trigger');
  let started = false;
  const result = await triggerWeeklyJobForTenant('15', {
    needsMetaConnection: async () => true,
    loadBrandKit: async () => makeKit(),
    loadPayloadDefaults: okDefaults as never,
    startJob: (async () => { started = true; return { status: 'accepted', jobId: 'x' }; }) as never,
    now: () => FRESH_NOW,
  });
  assert.deepEqual(result, { status: 'skipped', reason: 'no_channel' });
  assert.equal(started, false, 'must not start a job for a tenant that cannot publish');
});

test('helper gate 2: unenriched brand kit → skipped(stale_brand_kit)', async () => {
  const { triggerWeeklyJobForTenant } = await import('../../backend/marketing/weekly-trigger');
  const result = await triggerWeeklyJobForTenant('15', {
    needsMetaConnection: async () => false,
    loadBrandKit: async () => makeKit({ positioning: null, audience: null, tone_of_voice: null, style_vibe: null }),
    loadPayloadDefaults: okDefaults as never,
    startJob: (async () => ({ status: 'accepted', jobId: 'x' })) as never,
    now: () => FRESH_NOW,
  });
  assert.deepEqual(result, { status: 'skipped', reason: 'stale_brand_kit' });
});

test('helper gate 2: stale brand kit (old extracted_at) → skipped(stale_brand_kit)', async () => {
  const { triggerWeeklyJobForTenant } = await import('../../backend/marketing/weekly-trigger');
  const result = await triggerWeeklyJobForTenant('15', {
    needsMetaConnection: async () => false,
    loadBrandKit: async () => makeKit({ extracted_at: '2026-05-01T00:00:00.000Z' }), // >7d before FRESH_NOW
    loadPayloadDefaults: okDefaults as never,
    startJob: (async () => ({ status: 'accepted', jobId: 'x' })) as never,
    now: () => FRESH_NOW,
  });
  assert.deepEqual(result, { status: 'skipped', reason: 'stale_brand_kit' });
});

test('helper gate 3: missing website/businessType → skipped(incomplete_profile)', async () => {
  const { triggerWeeklyJobForTenant } = await import('../../backend/marketing/weekly-trigger');
  const result = await triggerWeeklyJobForTenant('15', {
    needsMetaConnection: async () => false,
    loadBrandKit: async () => makeKit(),
    loadPayloadDefaults: (async () => ({ businessType: 'coaching' })) as never, // no websiteUrl
    startJob: (async () => ({ status: 'accepted', jobId: 'x' })) as never,
    now: () => FRESH_NOW,
  });
  assert.deepEqual(result, { status: 'skipped', reason: 'incomplete_profile' });
});

test('helper happy path: all gates pass → started with the job id + stage', async () => {
  const { triggerWeeklyJobForTenant } = await import('../../backend/marketing/weekly-trigger');
  let startArg: unknown = null;
  const result = await triggerWeeklyJobForTenant('15', {
    needsMetaConnection: async () => false,
    loadBrandKit: async () => makeKit(),
    loadPayloadDefaults: okDefaults as never,
    findRecentJobId: async () => null,
    startJob: (async (input: unknown) => {
      startArg = input;
      return { status: 'accepted', jobId: 'mkt_weekly_1', currentStage: 'research', approvalRequired: true };
    }) as never,
    now: () => FRESH_NOW,
  });
  assert.deepEqual(result, {
    status: 'started', jobId: 'mkt_weekly_1', currentStage: 'research', approvalRequired: true,
  });
  const arg = startArg as { jobType: string; tenantId: string; createdBy: string; payload: Record<string, unknown> };
  assert.equal(arg.jobType, 'weekly_social_content');
  assert.equal(arg.tenantId, '15');
  assert.equal(arg.createdBy, 'weekly-trigger-worker');
  assert.equal(arg.payload.brandUrl, 'https://brand.example');
  assert.equal(arg.payload.businessType, 'coaching');
});

test('helper: startJob throw → error result (worker can revert + retry)', async () => {
  const { triggerWeeklyJobForTenant } = await import('../../backend/marketing/weekly-trigger');
  const result = await triggerWeeklyJobForTenant('15', {
    needsMetaConnection: async () => false,
    loadBrandKit: async () => makeKit(),
    loadPayloadDefaults: okDefaults as never,
    findRecentJobId: async () => null,
    startJob: (async () => { throw new Error('hermes submit failed'); }) as never,
    now: () => FRESH_NOW,
  });
  assert.equal(result.status, 'error');
});

test('helper idempotency: a recent worker-created weekly job → deduped, startJob NOT called', async () => {
  const { triggerWeeklyJobForTenant } = await import('../../backend/marketing/weekly-trigger');
  let started = false;
  let lookupArgs: unknown = null;
  const result = await triggerWeeklyJobForTenant('15', {
    needsMetaConnection: async () => false,
    loadBrandKit: async () => makeKit(),
    loadPayloadDefaults: okDefaults as never,
    findRecentJobId: (async (tenantId: string, opts: unknown) => {
      lookupArgs = { tenantId, opts };
      return 'mkt_existing_weekly';
    }) as never,
    startJob: (async () => { started = true; return { status: 'accepted', jobId: 'mkt_new' }; }) as never,
    now: () => FRESH_NOW,
  });
  assert.deepEqual(result, { status: 'started', jobId: 'mkt_existing_weekly', deduped: true });
  assert.equal(started, false, 'a lost-response re-fire must not start a SECOND weekly job');
  const args = lookupArgs as { tenantId: string; opts: { jobType: string; createdBy: string; sinceEpochMs: number } };
  assert.equal(args.tenantId, '15');
  assert.equal(args.opts.jobType, 'weekly_social_content');
  assert.equal(args.opts.createdBy, 'weekly-trigger-worker');
  // 6-day dedup window, shorter than the weekly cadence.
  assert.equal(FRESH_NOW - args.opts.sinceEpochMs, 6 * 24 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Dedup scanner (findRecentJobIdForTenant) against a real DATA_ROOT
// ---------------------------------------------------------------------------

test('findRecentJobIdForTenant: matches only recent, same-tenant, worker-created weekly jobs', async () => {
  const prevDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-weekly-dedup-'));
  const jobsDir = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
  await mkdir(jobsDir, { recursive: true });
  process.env.DATA_ROOT = dataRoot;
  const NOW = Date.parse('2026-06-04T12:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const writeDoc = (d: Record<string, unknown>) =>
    writeFile(path.join(jobsDir, `${d.job_id}.json`), JSON.stringify(d));
  try {
    const { findRecentJobIdForTenant } = await import('../../backend/marketing/runtime-state');
    const base = { schema_name: 'marketing_job_state_schema', tenant_id: '15', stages: { research: {} } };
    // MATCH: recent, tenant 15, worker-created weekly.
    await writeDoc({ ...base, job_id: 'mkt_match', job_type: 'weekly_social_content', created_by: 'weekly-trigger-worker', created_at: iso(NOW - 60 * 60 * 1000) });
    // too old (10d before NOW)
    await writeDoc({ ...base, job_id: 'mkt_old', job_type: 'weekly_social_content', created_by: 'weekly-trigger-worker', created_at: iso(NOW - 10 * 24 * 60 * 60 * 1000) });
    // manual (different created_by)
    await writeDoc({ ...base, job_id: 'mkt_manual', job_type: 'weekly_social_content', created_by: 'user-5', created_at: iso(NOW - 60 * 60 * 1000) });
    // wrong tenant
    await writeDoc({ ...base, tenant_id: '16', job_id: 'mkt_other_tenant', job_type: 'weekly_social_content', created_by: 'weekly-trigger-worker', created_at: iso(NOW - 60 * 60 * 1000) });
    // soft-deleted
    await writeDoc({ ...base, job_id: 'mkt_deleted', job_type: 'weekly_social_content', created_by: 'weekly-trigger-worker', created_at: iso(NOW - 60 * 60 * 1000), deleted_at: iso(NOW) });

    const since = NOW - 6 * 24 * 60 * 60 * 1000;
    const found = await findRecentJobIdForTenant('15', {
      jobType: 'weekly_social_content', createdBy: 'weekly-trigger-worker', sinceEpochMs: since,
    });
    assert.equal(found, 'mkt_match', 'only the recent same-tenant worker weekly job matches');

    // A tighter cutoff (30 min) excludes the 1h-old match → null.
    const tighter = await findRecentJobIdForTenant('15', {
      jobType: 'weekly_social_content', createdBy: 'weekly-trigger-worker', sinceEpochMs: NOW - 30 * 60 * 1000,
    });
    assert.equal(tighter, null, 'nothing within the tighter window');
  } finally {
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Worker tick: claim / success / failure-revert / lost-race
// ---------------------------------------------------------------------------

type Call = { sql: string; params: unknown[] };

/** Fake pool that routes by SQL fragment. claimReturns controls the claim row. */
function makePool(rows: unknown[], opts: { claimRowCount?: number; prior?: string | null } = {}) {
  const calls: Call[] = [];
  const pool = {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM marketing_schedule\n    WHERE enabled') || sql.includes('WHERE enabled')) {
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('UPDATE marketing_schedule m')) {
        const rc = opts.claimRowCount ?? 1;
        return { rows: rc ? [{ prior_last_triggered_at: opts.prior ?? null }] : [], rowCount: rc };
      }
      // MARK_SUCCESS / REVERT
      return { rows: [], rowCount: 1 };
    },
  };
  return pool;
}

function fakeFetch(response: { ok: boolean; status: number; body: unknown }): typeof fetch {
  return (async () => ({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  })) as unknown as typeof fetch;
}

const DUE_ROW = { tenant_id: 15, day_of_week: 1, hour: 9, timezone: 'UTC', last_triggered_at: null };
const TICK_NOW = new Date('2026-06-04T12:00:00.000Z'); // after Mon 09:00 UTC → due

test('worker tick: due tenant, claim wins, started → marks success', async () => {
  const prev = process.env.APP_BASE_URL; const prevSecret = process.env.INTERNAL_API_SECRET;
  process.env.APP_BASE_URL = 'https://aries.example.com'; process.env.INTERNAL_API_SECRET = 'shh';
  try {
    const { tick } = await import('../../scripts/automations/weekly-job-trigger-worker');
    const pool = makePool([DUE_ROW], { claimRowCount: 1, prior: null });
    const report = await tick(pool, { now: TICK_NOW, fetchImpl: fakeFetch({ ok: true, status: 200, body: { status: 'started', jobId: 'mkt_1' } }) });
    assert.equal(report.due, 1);
    assert.equal(report.claimed, 1);
    assert.equal(report.started, 1);
    assert.equal(report.failed, 0);
    assert.ok(pool.calls.some((c) => c.sql.includes('last_success_at = now()')), 'success must be marked');
    assert.ok(!pool.calls.some((c) => c.sql.includes('SET last_triggered_at = $2')), 'must not revert on success');
  } finally {
    process.env.APP_BASE_URL = prev; process.env.INTERNAL_API_SECRET = prevSecret;
  }
});

test('worker tick: due tenant, trigger fails (HTTP 500) → reverts claim, counts failed', async () => {
  const prev = process.env.APP_BASE_URL; const prevSecret = process.env.INTERNAL_API_SECRET;
  process.env.APP_BASE_URL = 'https://aries.example.com'; process.env.INTERNAL_API_SECRET = 'shh';
  try {
    const { tick } = await import('../../scripts/automations/weekly-job-trigger-worker');
    const pool = makePool([DUE_ROW], { claimRowCount: 1, prior: '2026-05-20T09:00:00.000Z' });
    const report = await tick(pool, { now: TICK_NOW, fetchImpl: fakeFetch({ ok: false, status: 500, body: { status: 'error' } }) });
    assert.equal(report.claimed, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.started, 0);
    const revert = pool.calls.find((c) => c.sql.includes('SET last_triggered_at = $2'));
    assert.ok(revert, 'failure must revert the claim');
    assert.equal(revert!.params[1], '2026-05-20T09:00:00.000Z', 'revert restores the prior timestamp');
  } finally {
    process.env.APP_BASE_URL = prev; process.env.INTERNAL_API_SECRET = prevSecret;
  }
});

test('worker tick: due tenant, gate skip (200 skipped) → keeps claim, counts skipped', async () => {
  const prev = process.env.APP_BASE_URL; const prevSecret = process.env.INTERNAL_API_SECRET;
  process.env.APP_BASE_URL = 'https://aries.example.com'; process.env.INTERNAL_API_SECRET = 'shh';
  try {
    const { tick } = await import('../../scripts/automations/weekly-job-trigger-worker');
    const pool = makePool([DUE_ROW], { claimRowCount: 1, prior: null });
    const report = await tick(pool, { now: TICK_NOW, fetchImpl: fakeFetch({ ok: true, status: 200, body: { status: 'skipped', reason: 'no_channel' } }) });
    assert.equal(report.skipped, 1);
    assert.equal(report.started, 0);
    assert.ok(!pool.calls.some((c) => c.sql.includes('SET last_triggered_at = $2')), 'a deliberate skip keeps the claim (no retry this window)');
    assert.ok(!pool.calls.some((c) => c.sql.includes('last_success_at = now()')), 'a skip is not a success');
  } finally {
    process.env.APP_BASE_URL = prev; process.env.INTERNAL_API_SECRET = prevSecret;
  }
});

test('worker tick: lost the claim race (0 rows returned) → no POST, no-op', async () => {
  const prev = process.env.APP_BASE_URL; const prevSecret = process.env.INTERNAL_API_SECRET;
  process.env.APP_BASE_URL = 'https://aries.example.com'; process.env.INTERNAL_API_SECRET = 'shh';
  try {
    const { tick } = await import('../../scripts/automations/weekly-job-trigger-worker');
    const pool = makePool([DUE_ROW], { claimRowCount: 0 });
    let fetched = false;
    const report = await tick(pool, { now: TICK_NOW, fetchImpl: (async () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch });
    assert.equal(report.due, 1);
    assert.equal(report.claimed, 0);
    assert.equal(report.started, 0);
    assert.equal(fetched, false, 'a tenant we did not claim must not be triggered');
  } finally {
    process.env.APP_BASE_URL = prev; process.env.INTERNAL_API_SECRET = prevSecret;
  }
});

test('worker tick: not-due tenant (recent last_triggered_at) → not claimed', async () => {
  const prev = process.env.APP_BASE_URL; const prevSecret = process.env.INTERNAL_API_SECRET;
  process.env.APP_BASE_URL = 'https://aries.example.com'; process.env.INTERNAL_API_SECRET = 'shh';
  try {
    const { tick } = await import('../../scripts/automations/weekly-job-trigger-worker');
    // last_triggered_at AFTER this week's Monday slot → not due.
    const row = { ...DUE_ROW, last_triggered_at: '2026-06-01T09:00:01.000Z' };
    const pool = makePool([row], { claimRowCount: 1 });
    const report = await tick(pool, { now: TICK_NOW, fetchImpl: fakeFetch({ ok: true, status: 200, body: { status: 'started' } }) });
    assert.equal(report.due, 0, 'already triggered this window → not due');
    assert.equal(report.claimed, 0);
    assert.ok(!pool.calls.some((c) => c.sql.includes('UPDATE marketing_schedule m')), 'no claim attempted when not due');
  } finally {
    process.env.APP_BASE_URL = prev; process.env.INTERNAL_API_SECRET = prevSecret;
  }
});
