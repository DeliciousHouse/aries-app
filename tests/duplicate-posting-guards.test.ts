import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeAutoScheduleSlots } from '../backend/marketing/auto-schedule';
import { buildAutoScheduleRows, type AutoSchedulePostRow, type WeeklyScheduleEntry } from '../backend/marketing/hermes-callbacks';
import { synthesizePublishPostsFromContentPackage } from '../backend/marketing/synthesize-publish-posts';
import type { SocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';
import {
  resolvePublishGuards,
  duplicateCaptionWindowDays,
  samePlatformSpacingMinutes,
  type DispatchQueryable,
} from '../app/api/internal/publishing/scheduled-dispatch/route';

// ---------------------------------------------------------------------------
// Regression suite for the 2026-07-13 duplicate-posting incident:
// six IG feed posts (same image, different captions) published within 50
// seconds at the identical scheduled instant, driven by three stacked defects:
//   1. buildAutoScheduleRows missed platform_targets[].recommended_day (the
//      current Hermes wire shape) → every row's day was null;
//   2. null days all fell into the "first day in window" fallback with no
//      collision guard → one identical instant for the whole week;
//   3. the weekly-REEL companion job (created_by 'reel:<id>') synthesized a
//      full 7-post week instead of only its reel.
// Plus the publish-boundary guards (duplicate caption + same-platform
// spacing) that make any recurrence structurally impossible.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-13T14:07:25.000Z'); // Monday, incident time
const CAMPAIGN_START = new Date('2026-07-13T14:07:25.000Z');
const CAMPAIGN_END = new Date('2026-07-20T14:07:25.000Z'); // the reel job's real 7-day window
const TZ_LA = 'America/Los_Angeles'; // tenant 15's zone during the incident

// --- 1. Per-target recommended_day parsing ---------------------------------

function incidentSchedule(): WeeklyScheduleEntry[] {
  // Exactly the wire shape the Hermes publish stage emitted on 2026-07-13:
  // recommended_day lives INSIDE platform_targets, not on the entry.
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days.map((day, i) => ({
    post_number: i + 1,
    platform_targets: [
      { platform: 'instagram', placement: 'feed' as const, recommended_day: day },
      { platform: 'facebook', placement: 'feed' as const, recommended_day: day },
    ],
  }));
}

function incidentPostRows(jobId: string): AutoSchedulePostRow[] {
  const rows: AutoSchedulePostRow[] = [];
  for (let n = 1; n <= 6; n += 1) {
    for (const platform of ['instagram', 'facebook']) {
      rows.push({
        id: n * 100 + (platform === 'instagram' ? 1 : 2),
        platform,
        idempotency_key: `${jobId}:${n}:${platform}:feed`,
        surface: 'feed',
        media_type: 'image',
        width_px: null,
        height_px: null,
        duration_seconds: null,
      });
    }
  }
  return rows;
}

test('incident replay: platform_targets[].recommended_day is honored (days no longer null)', () => {
  const rows = buildAutoScheduleRows(incidentPostRows('job_inc'), incidentSchedule(), 'job_inc');
  assert.equal(rows.length, 12);
  const igDays = rows.filter((r) => r.platform === 'instagram').map((r) => r.recommendedDay);
  assert.deepEqual(igDays, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
});

test('per-target day falls back to the entry-level day when absent', () => {
  const schedule: WeeklyScheduleEntry[] = [
    { post_number: 1, recommended_day: 'Friday', platform_targets: [{ platform: 'instagram', placement: 'feed' }] },
  ];
  const rows = buildAutoScheduleRows(
    incidentPostRows('job_fb').filter((r) => r.idempotency_key === 'job_fb:1:instagram:feed'),
    schedule,
    'job_fb',
  );
  assert.equal(rows[0]?.recommendedDay, 'Friday');
});

test('incident replay end-to-end: six feed posts spread across six days, no shared instant', () => {
  const rows = buildAutoScheduleRows(incidentPostRows('job_e2e'), incidentSchedule(), 'job_e2e');
  const result = computeAutoScheduleSlots({
    rows,
    tenantTimezone: TZ_LA,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped));
  const igInstants = result.slots.filter((s) => s.platform === 'instagram').map((s) => s.scheduledFor.toISOString());
  assert.equal(new Set(igInstants).size, 6, `IG instants must be unique, got ${igInstants.join(', ')}`);
  const fbInstants = result.slots.filter((s) => s.platform === 'facebook').map((s) => s.scheduledFor.toISOString());
  assert.equal(new Set(fbInstants).size, 6, `FB instants must be unique, got ${fbInstants.join(', ')}`);
});

// --- 2. Same-instant de-collision guard -------------------------------------

test('de-collision: six null-day rows never share an instant (the pre-fix collapse shape)', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    postId: 400 + i,
    platform: 'instagram',
    recommendedDay: null,
  }));
  const result = computeAutoScheduleSlots({
    rows,
    tenantTimezone: TZ_LA,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 6, 'volume is never dropped');
  const instants = result.slots.map((s) => s.scheduledFor.toISOString());
  assert.equal(new Set(instants).size, 6, `instants must be unique, got ${instants.join(', ')}`);
});

test('de-collision: two posts on the same recommended day get distinct instants (day ladder)', () => {
  const rows = [
    { postId: 1, platform: 'instagram', recommendedDay: 'Wednesday' },
    { postId: 2, platform: 'instagram', recommendedDay: 'Wednesday' },
  ];
  const result = computeAutoScheduleSlots({
    rows,
    tenantTimezone: TZ_LA,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 2);
  assert.notEqual(
    result.slots[0].scheduledFor.toISOString(),
    result.slots[1].scheduledFor.toISOString(),
  );
});

test('de-collision inside a sub-day window: falls back to intra-day steps, still unique, volume kept', () => {
  const shortEnd = new Date('2026-07-14T02:00:00.000Z'); // < 1 day of window
  const rows = Array.from({ length: 3 }, (_, i) => ({
    postId: i + 1,
    platform: 'instagram',
    recommendedDay: null,
  }));
  const result = computeAutoScheduleSlots({
    rows,
    tenantTimezone: TZ_LA,
    campaignStart: CAMPAIGN_START,
    campaignEnd: shortEnd,
    now: NOW,
  });
  assert.equal(result.slots.length + result.skipped.length, 3);
  const instants = result.slots.map((s) => s.scheduledFor.toISOString());
  assert.equal(new Set(instants).size, instants.length, 'no shared instants even in a short window');
});

test('de-collision: cross-platform pairs are independent (IG and FB may share a calendar day)', () => {
  const rows = [
    { postId: 1, platform: 'instagram', recommendedDay: 'Tuesday' },
    { postId: 2, platform: 'facebook', recommendedDay: 'Tuesday' },
  ];
  const result = computeAutoScheduleSlots({
    rows,
    tenantTimezone: TZ_LA,
    campaignStart: CAMPAIGN_START,
    campaignEnd: CAMPAIGN_END,
    now: NOW,
  });
  assert.equal(result.slots.length, 2);
  // Different platform hours — same day, different instants, and neither is
  // treated as a collision (appliedDay carries no de-collided marker).
  for (const slot of result.slots) {
    assert.ok(!slot.appliedDay.includes('de-collided'), slot.appliedDay);
  }
});

// --- 3. Reel-companion synthesis clamp ---------------------------------------

function makeFakePool() {
  const inserts: unknown[][] = [];
  return {
    inserts,
    pool: {
      async query(sql: string, params: unknown[] = []) {
        if (/INSERT INTO posts/i.test(sql)) {
          inserts.push(params);
          return { rows: [{ id: inserts.length }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
}

function stage(name: string, primaryOutput: unknown) {
  return {
    stage: name, status: 'completed', started_at: null, completed_at: null,
    failed_at: null, run_id: null, summary: null, primary_output: primaryOutput,
    outputs: {}, artifacts: [], errors: [],
  };
}

function makeDoc(jobId: string, createdBy: string | null): SocialContentJobRuntimeDocument {
  const schedule = [
    { post_number: 1, platforms: ['instagram'], placement: 'feed', media_type: 'image' },
    { post_number: 2, platforms: ['instagram'], placement: 'reel', media_type: 'video' },
  ];
  return {
    schema_name: 'marketing_job_state_schema', schema_version: '1.0.0', job_id: jobId,
    tenant_id: '15', job_type: 'one_off_post', state: 'completed', status: 'completed',
    current_stage: 'publish', created_by: createdBy,
    stages: {
      research: stage('research', null),
      strategy: stage('strategy', null),
      production: stage('production', {
        stage: 'production',
        content_package: [
          { post_number: 1, hook: 'H1', body: 'B1', cta: 'C1', hashtags: ['#a'], platforms: ['instagram'] },
          { post_number: 2, hook: 'H2', body: 'B2', cta: 'C2', hashtags: ['#b'], platforms: ['instagram'] },
        ],
      }),
      publish: stage('publish', { stage: 'publish', schedule }),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: [], live_publish_platforms: [], video_render_platforms: [] },
    brand_kit: null, inputs: { request: {}, brand_url: 'https://example.com' },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;
}

async function withDataRoot<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dup-guards-'));
  const prev = process.env.DATA_ROOT;
  process.env.DATA_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test('reel-companion clamp: created_by reel:* synthesizes ONLY the reel/video row', async () => {
  await withDataRoot(async () => {
    process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
    const { pool, inserts } = makeFakePool();
    try {
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_reel', tenantId: 15,
        doc: makeDoc('job_reel', 'reel:mkt_parent_weekly'), publishRunId: null, pool,
      });
    } finally {
      delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    }
    assert.equal(inserts.length, 1, 'feed-image entry must be clamped away');
    assert.equal(inserts[0][8], 'reel');
    assert.equal(inserts[0][7], 'video');
  });
});

test('reel-companion clamp: non-reel jobs are untouched (both rows synthesize)', async () => {
  await withDataRoot(async () => {
    process.env.ARIES_VIDEO_PUBLISH_ENABLED = '1';
    const { pool, inserts } = makeFakePool();
    try {
      await synthesizePublishPostsFromContentPackage({
        jobId: 'job_norm', tenantId: 15,
        doc: makeDoc('job_norm', 'weekly-trigger-worker'), publishRunId: null, pool,
      });
    } finally {
      delete process.env.ARIES_VIDEO_PUBLISH_ENABLED;
    }
    assert.equal(inserts.length, 2);
  });
});

// --- 4. Publish-boundary guards ----------------------------------------------

function fakeDb(handler: (sql: string, params: unknown[]) => { rows: unknown[] }): DispatchQueryable {
  return {
    async query<T>(sql: string, params: unknown[]) {
      return handler(sql, params) as { rows: T[] };
    },
  } as DispatchQueryable;
}

const GUARD_ARGS = {
  tenantId: '15',
  postId: '999',
  platforms: ['instagram', 'facebook'],
  content: 'A caption long enough to be treated as content identity for the guard.',
  surface: 'feed' as const,
  now: new Date('2026-07-13T15:00:00.000Z'),
};

test('duplicate-caption guard: identical caption on the same platform → terminal duplicate verdict', async () => {
  const db = fakeDb((sql) => {
    if (/btrim\(caption\)/i.test(sql)) return { rows: [{ platform: 'instagram' }] };
    return { rows: [] };
  });
  const verdicts = await resolvePublishGuards({ db, ...GUARD_ARGS });
  assert.equal(verdicts.get('instagram')?.blocked, 'duplicate');
  assert.equal(verdicts.get('facebook'), undefined);
});

test('spacing guard: publish 5 minutes ago on the platform → spacing defer verdict', async () => {
  const db = fakeDb((sql) => {
    if (/max\(published_at\)/i.test(sql)) {
      return { rows: [{ platform: 'instagram', last_published: '2026-07-13T14:55:00.000Z' }] };
    }
    return { rows: [] };
  });
  const verdicts = await resolvePublishGuards({ db, ...GUARD_ARGS });
  assert.equal(verdicts.get('instagram')?.blocked, 'spacing');
});

test('spacing guard: publish outside the window → admitted', async () => {
  const db = fakeDb((sql) => {
    if (/max\(published_at\)/i.test(sql)) {
      return { rows: [{ platform: 'instagram', last_published: '2026-07-13T13:00:00.000Z' }] };
    }
    return { rows: [] };
  });
  const verdicts = await resolvePublishGuards({ db, ...GUARD_ARGS });
  assert.equal(verdicts.size, 0);
});

test('duplicate verdict wins over spacing for the same platform', async () => {
  const db = fakeDb((sql) => {
    if (/btrim\(caption\)/i.test(sql)) return { rows: [{ platform: 'instagram' }] };
    if (/max\(published_at\)/i.test(sql)) {
      return { rows: [{ platform: 'instagram', last_published: '2026-07-13T14:59:00.000Z' }] };
    }
    return { rows: [] };
  });
  const verdicts = await resolvePublishGuards({ db, ...GUARD_ARGS });
  assert.equal(verdicts.get('instagram')?.blocked, 'duplicate');
});

test('guards fail OPEN: a throwing DB admits every platform', async () => {
  const db = fakeDb(() => { throw new Error('db down'); });
  const verdicts = await resolvePublishGuards({ db, ...GUARD_ARGS });
  assert.equal(verdicts.size, 0);
});

test('short captions are exempt from the duplicate guard but not from spacing', async () => {
  let captionQueried = false;
  const db = fakeDb((sql) => {
    if (/btrim\(caption\)/i.test(sql)) { captionQueried = true; return { rows: [{ platform: 'instagram' }] }; }
    if (/max\(published_at\)/i.test(sql)) {
      return { rows: [{ platform: 'instagram', last_published: '2026-07-13T14:58:00.000Z' }] };
    }
    return { rows: [] };
  });
  const verdicts = await resolvePublishGuards({ db, ...GUARD_ARGS, content: 'Sale on!' });
  assert.equal(captionQueried, false, 'short caption must not run the duplicate query');
  assert.equal(verdicts.get('instagram')?.blocked, 'spacing');
});

test('env 0 disables each guard independently', async () => {
  const db = fakeDb((sql) => {
    if (/btrim\(caption\)/i.test(sql)) return { rows: [{ platform: 'instagram' }] };
    if (/max\(published_at\)/i.test(sql)) {
      return { rows: [{ platform: 'facebook', last_published: '2026-07-13T14:59:00.000Z' }] };
    }
    return { rows: [] };
  });
  const off = await resolvePublishGuards({
    db, ...GUARD_ARGS,
    env: {
      ARIES_DUPLICATE_CAPTION_WINDOW_DAYS: '0',
      ARIES_SAME_PLATFORM_MIN_SPACING_MINUTES: '0',
    } as unknown as NodeJS.ProcessEnv,
  });
  assert.equal(off.size, 0);
});

test('duplicate guard is surface-scoped: the story promotion may reuse its feed sibling caption', async () => {
  // The image-story promotion inserts a surface='story' post with the feed
  // post's caption VERBATIM on the same platform (storyCount defaults to 1
  // on form-created weekly jobs). The duplicate query must therefore carry
  // the dispatching surface so a story is only compared against prior
  // stories — a platform-wide match would terminally block every promoted
  // story as a "duplicate" of its own feed sibling.
  let dupParams: unknown[] | null = null;
  let dupSql = '';
  const db = fakeDb((sql, params) => {
    if (/btrim\(caption\)/i.test(sql)) { dupSql = sql; dupParams = params; return { rows: [] }; }
    return { rows: [] };
  });
  await resolvePublishGuards({ ...GUARD_ARGS, db, surface: 'story' });
  assert.match(dupSql, /AND surface = \$6/);
  assert.ok(dupParams, 'duplicate query ran');
  assert.equal((dupParams as unknown as unknown[])[5], 'story');
});

test('guard env parsing: defaults 14d / 30m; invalid values fall back', () => {
  assert.equal(duplicateCaptionWindowDays({} as NodeJS.ProcessEnv), 14);
  assert.equal(samePlatformSpacingMinutes({} as NodeJS.ProcessEnv), 30);
  assert.equal(duplicateCaptionWindowDays({ ARIES_DUPLICATE_CAPTION_WINDOW_DAYS: 'x' } as unknown as NodeJS.ProcessEnv), 14);
  assert.equal(samePlatformSpacingMinutes({ ARIES_SAME_PLATFORM_MIN_SPACING_MINUTES: '-5' } as unknown as NodeJS.ProcessEnv), 30);
  assert.equal(duplicateCaptionWindowDays({ ARIES_DUPLICATE_CAPTION_WINDOW_DAYS: '0' } as unknown as NodeJS.ProcessEnv), 0);
  assert.equal(samePlatformSpacingMinutes({ ARIES_SAME_PLATFORM_MIN_SPACING_MINUTES: '45' } as unknown as NodeJS.ProcessEnv), 45);
});
