/**
 * Unit tests for the default-cadence scheduling path (Part A).
 *
 * Covers the `computeDefaultCadenceSlots` pure helper added to auto-schedule.ts
 * and the integration wiring in `autoScheduleApprovedPostsForJob` when
 * `weeklySchedule.length === 0` (the case where the Hermes publish stage emits
 * a strategy-shaped placeholder instead of `schedule[]`).
 *
 * Reproduces the mkt_c8ee6236 scenario: 14 posts (7 IG + 7 FB, ordinals 1-7),
 * empty weekly_schedule → all 14 slots computed, 7 distinct days, ordinal order
 * == date order, IG+FB of the same ordinal share a day.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/marketing/default-cadence-slots.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// ---------------------------------------------------------------------------
// Pure-helper tests (no DB, no env): computeDefaultCadenceSlots
// ---------------------------------------------------------------------------

test('computeDefaultCadenceSlots: 7 IG + 7 FB → 7 distinct days, same-ordinal pair same day, ordinal 1 first', async () => {
  const { computeDefaultCadenceSlots } = await import('../../backend/marketing/auto-schedule');

  // 14 posts: ordinals 1-7, each with instagram + facebook
  const rows = [];
  for (let ord = 1; ord <= 7; ord++) {
    rows.push({ postId: ord * 100, platform: 'instagram', ordinal: ord });
    rows.push({ postId: ord * 100 + 1, platform: 'facebook', ordinal: ord });
  }

  const now = new Date('2026-06-24T12:00:00Z');
  const campaignStart = new Date('2026-06-24T00:00:00Z');
  const campaignEnd = new Date('2026-07-08T23:59:59Z'); // 14 days

  const result = computeDefaultCadenceSlots({ rows, tenantTimezone: 'America/New_York', campaignStart, campaignEnd, now });

  assert.equal(result.slots.length, 14, `expected 14 slots, got ${result.slots.length}`);
  assert.equal(result.skipped.length, 0, `expected 0 skipped, got ${result.skipped.length}: ${JSON.stringify(result.skipped.map(s => s.reason))}`);

  // 7 distinct calendar days (ordinal 1..7)
  const dateSet = new Set(result.slots.map((s) => s.scheduledFor.toISOString().slice(0, 10)));
  assert.equal(dateSet.size, 7, `expected 7 distinct days, got ${dateSet.size}: ${[...dateSet].join(', ')}`);

  // Ordinal 1 lands before ordinal 2 etc. (ordinal order == date order)
  const igSlots = result.slots.filter((s) => s.platform === 'instagram').sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
  for (let i = 1; i < igSlots.length; i++) {
    assert.ok(
      igSlots[i].scheduledFor >= igSlots[i - 1].scheduledFor,
      `IG slots out of date order: slot[${i - 1}]=${igSlots[i-1].scheduledFor.toISOString()} > slot[${i}]=${igSlots[i].scheduledFor.toISOString()}`,
    );
  }

  // IG + FB of the same ordinal share a calendar day
  for (let ord = 1; ord <= 7; ord++) {
    const igSlot = result.slots.find((s) => s.postId === ord * 100);
    const fbSlot = result.slots.find((s) => s.postId === ord * 100 + 1);
    assert.ok(igSlot, `missing IG slot for ordinal ${ord}`);
    assert.ok(fbSlot, `missing FB slot for ordinal ${ord}`);
    const igDay = igSlot!.scheduledFor.toISOString().slice(0, 10);
    const fbDay = fbSlot!.scheduledFor.toISOString().slice(0, 10);
    assert.equal(igDay, fbDay, `ordinal ${ord}: IG day ${igDay} != FB day ${fbDay}`);
  }
});

test('computeDefaultCadenceSlots: ordinal 1 on the base day, ordinal 2 the next, etc.', async () => {
  const { computeDefaultCadenceSlots } = await import('../../backend/marketing/auto-schedule');

  const rows = [
    { postId: 1, platform: 'instagram', ordinal: 1 },
    { postId: 2, platform: 'instagram', ordinal: 2 },
    { postId: 3, platform: 'instagram', ordinal: 3 },
  ];

  // now is well before 11:00 ET, so baseDate = now + 10min, which is the same
  // calendar day at 11:00 ET for ordinal 1.
  const now = new Date('2026-06-24T06:00:00Z'); // 02:00 ET, hours before IG slot
  const campaignStart = new Date('2026-06-24T00:00:00Z');
  const campaignEnd = new Date('2026-07-08T23:59:59Z');

  const result = computeDefaultCadenceSlots({ rows, tenantTimezone: 'America/New_York', campaignStart, campaignEnd, now });

  assert.equal(result.slots.length, 3);

  // Dates should be 3 consecutive days
  const days = result.slots.map((s) => s.scheduledFor.toISOString().slice(0, 10));
  assert.equal(days[0], '2026-06-24', `ordinal 1 should be 2026-06-24, got ${days[0]}`);
  assert.equal(days[1], '2026-06-25', `ordinal 2 should be 2026-06-25, got ${days[1]}`);
  assert.equal(days[2], '2026-06-26', `ordinal 3 should be 2026-06-26, got ${days[2]}`);
});

test('computeDefaultCadenceSlots: default hour already passed → piece 1 scheduled TOMORROW, not skipped or ~7 days out', async () => {
  const { computeDefaultCadenceSlots } = await import('../../backend/marketing/auto-schedule');

  // IG posts at 11:00 ET = 15:00 UTC; simulate "now" is 19:10 UTC = 15:10 ET
  // (just after the platform's default hour). The baseDate roll-forward ensures
  // piece 1 lands TOMORROW (2026-06-25) at 11:00 ET, never skipped, never ~7d out.
  const now = new Date('2026-06-24T19:10:00Z'); // 15:10 ET — IG 11:00 just passed
  const campaignStart = new Date('2026-06-24T00:00:00Z');
  const campaignEnd = new Date('2026-07-08T23:59:59Z');

  const rows = [{ postId: 1, platform: 'instagram', ordinal: 1 }];

  const result = computeDefaultCadenceSlots({ rows, tenantTimezone: 'America/New_York', campaignStart, campaignEnd, now });

  // After the roll-forward fix: piece 1 MUST be scheduled (never silently dropped).
  assert.equal(result.slots.length, 1, `expected exactly 1 slot (tomorrow), got ${result.slots.length}. skipped: ${JSON.stringify(result.skipped.map(s => s.reason))}`);
  assert.equal(result.skipped.length, 0, `expected 0 skipped, got: ${JSON.stringify(result.skipped.map(s => s.reason))}`);

  // Piece 1 must land on tomorrow (2026-06-25), not today or ~7 days out.
  const slotDay = result.slots[0].scheduledFor.toISOString().slice(0, 10);
  assert.equal(slotDay, '2026-06-25', `piece 1 should land on 2026-06-25 (tomorrow), got ${slotDay}`);

  // Key invariant: no slot 7+ days away (the weekday-name bug we're preventing).
  for (const slot of result.slots) {
    const diffDays = (slot.scheduledFor.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    assert.ok(diffDays < 7, `slot pushed ${diffDays.toFixed(1)} days out (must be < 7)`);
  }
});

test('computeDefaultCadenceSlots: 7-piece job completing after both platform hours → all 14 posts scheduled, ordinal 1 = tomorrow', async () => {
  const { computeDefaultCadenceSlots } = await import('../../backend/marketing/auto-schedule');

  // Simulate completing AFTER both IG (11:00 ET) and FB (13:05 ET) default hours.
  // now = 19:10 UTC = 15:10 ET; both platform hours already passed today.
  // Expected: baseDate rolls forward to tomorrow (2026-06-25); all 14 posts land
  // on consecutive days starting tomorrow; 0 skipped.
  const now = new Date('2026-06-24T19:10:00Z'); // 15:10 ET
  const campaignStart = new Date('2026-06-24T00:00:00Z');
  const campaignEnd = new Date('2026-07-08T23:59:59Z'); // 14 days

  const rows = [];
  for (let ord = 1; ord <= 7; ord++) {
    rows.push({ postId: ord * 100, platform: 'instagram', ordinal: ord });
    rows.push({ postId: ord * 100 + 1, platform: 'facebook', ordinal: ord });
  }

  const result = computeDefaultCadenceSlots({ rows, tenantTimezone: 'America/New_York', campaignStart, campaignEnd, now });

  // All 14 posts must be scheduled — none silently dropped.
  assert.equal(result.slots.length, 14, `expected 14 slots, got ${result.slots.length}. skipped: ${JSON.stringify(result.skipped.map(s => s.reason))}`);
  assert.equal(result.skipped.length, 0, `expected 0 skipped, got ${result.skipped.length}: ${JSON.stringify(result.skipped.map(s => s.reason))}`);

  // Ordinal 1 must land on tomorrow (2026-06-25) for both platforms.
  const ord1Slots = result.slots.filter((s) => s.postId === 100 || s.postId === 101);
  for (const slot of ord1Slots) {
    const day = slot.scheduledFor.toISOString().slice(0, 10);
    assert.equal(day, '2026-06-25', `ordinal 1 (${slot.platform}) should be on 2026-06-25, got ${day}`);
  }

  // Ordinals must land on strictly increasing calendar days (ordinal order == date order).
  const igSlots = result.slots.filter((s) => s.platform === 'instagram').sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
  assert.equal(igSlots.length, 7);
  for (let i = 1; i < igSlots.length; i++) {
    const dayPrev = igSlots[i - 1].scheduledFor.toISOString().slice(0, 10);
    const dayCurr = igSlots[i].scheduledFor.toISOString().slice(0, 10);
    assert.ok(dayCurr > dayPrev, `IG ordinal ${i} (${dayPrev}) must precede ordinal ${i + 1} (${dayCurr})`);
  }

  // IG + FB of each ordinal share the same calendar day.
  for (let ord = 1; ord <= 7; ord++) {
    const igSlot = result.slots.find((s) => s.postId === ord * 100);
    const fbSlot = result.slots.find((s) => s.postId === ord * 100 + 1);
    assert.ok(igSlot && fbSlot, `missing slots for ordinal ${ord}`);
    const igDay = igSlot!.scheduledFor.toISOString().slice(0, 10);
    const fbDay = fbSlot!.scheduledFor.toISOString().slice(0, 10);
    assert.equal(igDay, fbDay, `ordinal ${ord}: IG ${igDay} and FB ${fbDay} must be on the same day`);
  }

  // 7 distinct calendar days total (one per ordinal).
  const daySet = new Set(result.slots.map((s) => s.scheduledFor.toISOString().slice(0, 10)));
  assert.equal(daySet.size, 7, `expected 7 distinct days, got ${daySet.size}: ${[...daySet].sort().join(', ')}`);
});

test('computeDefaultCadenceSlots: window shorter than piece count → overflow skipped, no throw', async () => {
  const { computeDefaultCadenceSlots } = await import('../../backend/marketing/auto-schedule');

  const rows = [
    { postId: 1, platform: 'instagram', ordinal: 1 },
    { postId: 2, platform: 'instagram', ordinal: 2 },
    { postId: 3, platform: 'instagram', ordinal: 3 },
    { postId: 4, platform: 'instagram', ordinal: 4 },
  ];

  const now = new Date('2026-06-24T06:00:00Z');
  const campaignStart = new Date('2026-06-24T00:00:00Z');
  // Only 2 days of window → ordinals 3 and 4 overflow
  const campaignEnd = new Date('2026-06-25T23:59:59Z');

  const result = computeDefaultCadenceSlots({ rows, tenantTimezone: 'America/New_York', campaignStart, campaignEnd, now });

  // ordinals 1 + 2 should slot; ordinals 3 + 4 overflow
  assert.ok(result.slots.length <= 2, `expected ≤2 slots in window, got ${result.slots.length}`);
  const overflowSkipped = result.skipped.filter((s) => s.reason.startsWith('overflow_beyond_window'));
  assert.ok(overflowSkipped.length >= 2, `expected ≥2 overflow skipped, got ${overflowSkipped.length}: ${JSON.stringify(result.skipped.map(s => s.reason))}`);
});

test('computeDefaultCadenceSlots: empty rows → empty result, no throw', async () => {
  const { computeDefaultCadenceSlots } = await import('../../backend/marketing/auto-schedule');

  const now = new Date('2026-06-24T12:00:00Z');
  const result = computeDefaultCadenceSlots({
    rows: [],
    tenantTimezone: 'America/New_York',
    campaignStart: new Date('2026-06-24T00:00:00Z'),
    campaignEnd: new Date('2026-07-08T23:59:59Z'),
    now,
  });

  assert.equal(result.slots.length, 0);
  assert.equal(result.skipped.length, 0);
});

// ---------------------------------------------------------------------------
// Golden: healthy job WITH a real weekly_schedule → existing path, not default cadence
// ---------------------------------------------------------------------------

test('computeAutoScheduleSlots: real weekly_schedule → slots use recommended_day, not ordinal offset', async () => {
  const { computeAutoScheduleSlots } = await import('../../backend/marketing/auto-schedule');

  // The existing API: rows have recommendedDay = 'Monday'. computeAutoScheduleSlots
  // must still use weekday logic (not ordinal offsets).
  const rows = [
    { postId: 1, platform: 'instagram', recommendedDay: 'Monday' },
    { postId: 2, platform: 'facebook', recommendedDay: 'Monday' },
  ];

  // now = Saturday 2026-06-27 → next Monday is 2026-06-29
  const now = new Date('2026-06-27T06:00:00Z'); // Saturday
  const campaignStart = new Date('2026-06-27T00:00:00Z');
  const campaignEnd = new Date('2026-07-11T23:59:59Z');

  const result = computeAutoScheduleSlots({ rows, tenantTimezone: 'America/New_York', campaignStart, campaignEnd, now });

  assert.equal(result.slots.length, 2, `expected 2 slots, got ${result.slots.length}`);

  // Both slots should land on a Monday (2026-06-29)
  for (const slot of result.slots) {
    const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(slot.scheduledFor);
    assert.equal(dayName, 'Monday', `expected slot on Monday, got ${dayName} (${slot.scheduledFor.toISOString()})`);
  }

  // appliedDay should reflect the weekday name, not an ordinal offset
  for (const slot of result.slots) {
    assert.ok(!slot.appliedDay.startsWith('default-cadence:'), `expected weekday appliedDay, got: ${slot.appliedDay}`);
  }
});

// ---------------------------------------------------------------------------
// Integration: empty schedule triggers the default-cadence path in the callback
// ---------------------------------------------------------------------------

test('autoScheduleApprovedPostsForJob (via callback): empty schedule → default-cadence posts SELECT fires', async () => {
  const { mkdtemp: mkd, rm: rmd } = await import('node:fs/promises');
  const { tmpdir: td } = await import('node:os');

  const prev: Record<string, string | undefined> = {
    DATA_ROOT: process.env.DATA_ROOT,
    APP_BASE_URL: process.env.APP_BASE_URL,
    ARIES_AUTO_APPROVE_MARKETING_PIPELINE: process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE,
    ARIES_AUTOSCHEDULE_ON_APPROVAL: process.env.ARIES_AUTOSCHEDULE_ON_APPROVAL,
  };

  const dataRoot = await mkd(path.join(td(), 'aries-default-cadence-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.APP_BASE_URL = 'https://aries.example.com';
  process.env.ARIES_AUTO_APPROVE_MARKETING_PIPELINE = '1';
  process.env.ARIES_AUTOSCHEDULE_ON_APPROVAL = '0';

  const sqls: string[] = [];
  let restorePool: (() => void) | null = null;

  try {
    const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime } =
      await import('../../backend/marketing/runtime-state');
    const { createExecutionRunRecord } = await import('../../backend/execution/run-store');
    const { handleHermesRunCallback } = await import('../../backend/execution/hermes-callbacks');
    const poolMod = await import('../../lib/db');
    const pool = poolMod.default;

    const origQuery = pool.query.bind(pool);
    restorePool = () => {
      (pool as { query: typeof origQuery }).query = origQuery;
    };
    (pool as { query: unknown }).query = async (sql: unknown) => {
      sqls.push(String(sql));
      return { rows: [{ id: 1, post_id: 1, tenant_id: 999, scheduled_for: new Date().toISOString(), target_platforms: ['instagram'], updated_at: new Date().toISOString() }], rowCount: 1 } as never;
    };

    const doc = createSocialContentJobRuntimeDocument({
      jobId: `mkt_default_cadence_${dataRoot.slice(-6)}`,
      tenantId: '999',
      payload: { brandUrl: 'https://brand.example', businessType: 'coaching', competitorUrl: '', imageCreativeCount: 1 },
      brandKit: {
        path: '/tmp/brand-kit.json', source_url: 'https://brand.example', canonical_url: 'https://brand.example',
        brand_name: 'Brand', logo_urls: [], colors: { primary: null, secondary: null, accent: null, palette: [] },
        font_families: [], external_links: [], extracted_at: new Date().toISOString(), brand_voice_summary: 'clear',
        offer_summary: null, positioning: null, audience: null, tone_of_voice: null, style_vibe: null,
      },
    });
    saveSocialContentJobRuntime(doc.job_id, doc);

    const run = createExecutionRunRecord({
      provider: 'hermes', domain: 'marketing', workflowKey: 'social_content_weekly', action: 'resume',
      tenantId: doc.tenant_id, marketingJobId: doc.job_id, stage: 'publish',
    });

    await handleHermesRunCallback({
      event_id: `evt-default-cadence-${dataRoot.slice(-6)}`,
      aries_run_id: run.aries_run_id,
      hermes_run_id: `hermes-default-cadence-${dataRoot.slice(-6)}`,
      status: 'completed',
      stage: 'publish',
      output: [
        {
          // Strategy-shaped placeholder: has content_package but NO schedule[]
          stage: 'strategy',
          content_package: [
            { post_number: 1, platforms: ['instagram', 'facebook'] },
          ],
        },
      ],
    });
  } finally {
    if (restorePool) restorePool();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rmd(dataRoot, { recursive: true, force: true });
  }

  // The default-cadence path should reach the posts SELECT (same as the
  // weekday-schedule path — it queries posts regardless of which path is taken).
  const AUTO_SCHEDULE_POSTS_SELECT = /select[\s\S]*idempotency_key[\s\S]*from\s+posts/i;
  const fired = sqls.some((s) => AUTO_SCHEDULE_POSTS_SELECT.test(s));
  assert.ok(
    fired,
    `default-cadence path must reach the auto-schedule posts SELECT. SQLs (trimmed): ${sqls.map((s) => s.replace(/\s+/g, ' ').slice(0, 80)).join(' | ')}`,
  );
});
