/**
 * Deliverable A (AA-217 v2) — the job-status report must state what the week
 * actually delivered.
 *
 * Two surfaces:
 *   - the completed-job SUBHEADLINE, which said "delivery summaries are
 *     available" while the run had dropped every requested story and the reel;
 *   - the weekly CALENDAR placeholders, which fell back to the literal 'meta'
 *     and so promised a Meta week to a tenant with no Meta connection.
 *
 * Both are asserted for parity first: with no marker and no override, the output
 * is exactly what it is today.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordDeliveryComposition } from '@/backend/marketing/delivery-composition';
import {
  __buildWeeklyCalendarSnapshotForTests,
  type SocialContentCalendarEvent,
} from '@/backend/marketing/jobs-status';
import type { SocialContentJobRuntimeDocument } from '@/backend/marketing/runtime-state';

const LEGACY_SUBHEADLINE =
  'Launch packages, review artifacts, and delivery summaries are available for the current social content job.';

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-delivery-truthfulness-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function completedWeeklyDoc(jobId: string): Promise<SocialContentJobRuntimeDocument> {
  const { createSocialContentJobRuntimeDocument } = await import('@/backend/marketing/runtime-state');
  const doc = createSocialContentJobRuntimeDocument({
    jobId,
    // Non-numeric on purpose: the calendar's connection lookup short-circuits,
    // so this exercises the report path with no DB in reach.
    tenantId: 'tenant_delivery_truthfulness',
    payload: {
      jobType: 'weekly_social_content',
      brandUrl: 'https://brand.example',
      businessType: 'local service',
      primaryGoal: 'Book appointments',
      storyCount: 2,
    },
    brandKit: {
      path: '/tmp/brand-kit.json',
      source_url: 'https://brand.example',
      canonical_url: 'https://brand.example',
      brand_name: 'Brand',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: '2026-08-11T00:00:00.000Z',
      brand_voice_summary: null,
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
    },
  });
  for (const stage of ['research', 'strategy', 'production', 'publish'] as const) {
    doc.stages[stage].status = 'completed';
    doc.stages[stage].started_at = '2026-08-11T00:00:00.000Z';
    doc.stages[stage].completed_at = '2026-08-11T00:10:00.000Z';
  }
  doc.state = 'completed';
  doc.status = 'completed';
  doc.current_stage = 'publish';
  return doc;
}

test('report: a completed Meta week keeps the legacy subheadline exactly (parity)', async () => {
  await withRuntimeEnv(async () => {
    const { saveSocialContentJobRuntime } = await import('@/backend/marketing/runtime-state');
    const { getMarketingJobStatus } = await import('@/backend/marketing/jobs-status');

    const doc = await completedWeeklyDoc('mkt_truth_parity');
    saveSocialContentJobRuntime(doc.job_id, doc);

    const status = await getMarketingJobStatus(doc.job_id);
    assert.equal(status.status, 'completed');
    assert.equal(status.summary.subheadline, LEGACY_SUBHEADLINE);
  });
});

test('report: a feed-only week says so, naming this tenant\'s platforms', async () => {
  await withRuntimeEnv(async () => {
    const { saveSocialContentJobRuntime } = await import('@/backend/marketing/runtime-state');
    const { getMarketingJobStatus } = await import('@/backend/marketing/jobs-status');

    const doc = await completedWeeklyDoc('mkt_truth_feed_only');
    recordDeliveryComposition(doc, {
      platforms: ['linkedin'],
      storiesRequested: 2,
      reelCompanionSkipped: true,
    });
    saveSocialContentJobRuntime(doc.job_id, doc);

    const status = await getMarketingJobStatus(doc.job_id);
    assert.ok(
      status.summary.subheadline.startsWith(LEGACY_SUBHEADLINE),
      'the existing sentence is kept, the disclosure is appended',
    );
    assert.match(status.summary.subheadline, /the 2 stories you asked for and the weekly reel/);
    assert.match(status.summary.subheadline, /LinkedIn/);
    assert.match(status.summary.subheadline, /feed posts only/);
    // Reviewer-required change 3.
    assert.doesNotMatch(status.summary.subheadline, /Reddit/);
  });
});

test('report: the disclosure also reaches the operator timeline', async () => {
  await withRuntimeEnv(async () => {
    const { saveSocialContentJobRuntime } = await import('@/backend/marketing/runtime-state');
    const { getMarketingJobStatus } = await import('@/backend/marketing/jobs-status');

    const doc = await completedWeeklyDoc('mkt_truth_timeline');
    recordDeliveryComposition(doc, {
      platforms: ['x', 'reddit'],
      storiesRequested: 1,
      reelCompanionSkipped: false,
    });
    saveSocialContentJobRuntime(doc.job_id, doc);

    const status = await getMarketingJobStatus(doc.job_id);
    const entry = status.timeline.find((item) => item.id === 'delivery-composition');
    assert.ok(entry, 'the feed-only week is on the timeline');
    assert.equal(entry.tone, 'info', 'nothing went wrong — this is a disclosure, not an error');
    assert.match(entry.description, /the story you asked for/);
    assert.match(entry.description, /X and Reddit/);
    assert.doesNotMatch(entry.description, /LinkedIn/);
    // And the runtime doc keeps its own history line for the audit trail.
    const { loadSocialContentJobRuntime } = await import('@/backend/marketing/runtime-state');
    const reloaded = await loadSocialContentJobRuntime(doc.job_id);
    assert.match(JSON.stringify(reloaded?.history ?? []), /1 requested story skipped/);
  });
});

test('report: a Meta week has no delivery-composition timeline entry at all (parity)', async () => {
  await withRuntimeEnv(async () => {
    const { saveSocialContentJobRuntime } = await import('@/backend/marketing/runtime-state');
    const { getMarketingJobStatus } = await import('@/backend/marketing/jobs-status');

    const doc = await completedWeeklyDoc('mkt_truth_timeline_parity');
    saveSocialContentJobRuntime(doc.job_id, doc);

    const status = await getMarketingJobStatus(doc.job_id);
    assert.equal(
      status.timeline.some((item) => item.id === 'delivery-composition'),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Calendar placeholders.
// ---------------------------------------------------------------------------

function platformsOf(events: SocialContentCalendarEvent[]): string[] {
  return events.map((event) => event.platform);
}

test('calendar: with no override every placeholder is byte-identical (parity)', async () => {
  await withRuntimeEnv(async () => {
    const doc = await completedWeeklyDoc('mkt_truth_cal_parity');
    const before = __buildWeeklyCalendarSnapshotForTests(doc);
    assert.ok(before.calendarEvents.length > 0);
    // Today's behaviour: placeholders cycle scope.channels (['meta','instagram']).
    for (const platform of platformsOf(before.calendarEvents)) {
      assert.ok(
        platform === 'meta' || platform === 'instagram',
        `unexpected placeholder platform ${platform} — the Meta calendar must not move`,
      );
    }
    // And passing an EMPTY override is the same as passing none.
    assert.deepEqual(
      platformsOf(__buildWeeklyCalendarSnapshotForTests(doc, []).calendarEvents),
      platformsOf(before.calendarEvents),
    );
  });
});

test('calendar: an alternate-primary tenant sees its real platforms, not "meta"', async () => {
  await withRuntimeEnv(async () => {
    const doc = await completedWeeklyDoc('mkt_truth_cal_alternate');
    const snapshot = __buildWeeklyCalendarSnapshotForTests(doc, ['linkedin', 'x']);
    const platforms = platformsOf(snapshot.calendarEvents);
    assert.ok(platforms.length > 0);
    assert.ok(
      platforms.every((p) => p === 'linkedin' || p === 'x'),
      `placeholders must name only the tenant's platforms, got ${platforms.join(',')}`,
    );
    assert.ok(platforms.includes('linkedin'));
    assert.ok(platforms.includes('x'));
    // The event count and shape are untouched — this is a labelling fix only.
    assert.equal(snapshot.calendarEvents.length, __buildWeeklyCalendarSnapshotForTests(doc).calendarEvents.length);
    assert.equal(snapshot.plannedPostCount, __buildWeeklyCalendarSnapshotForTests(doc).plannedPostCount);
  });
});

test('calendar: a single-platform tenant never sees a platform it does not have', async () => {
  await withRuntimeEnv(async () => {
    const doc = await completedWeeklyDoc('mkt_truth_cal_single');
    const platforms = platformsOf(
      __buildWeeklyCalendarSnapshotForTests(doc, ['linkedin']).calendarEvents,
    );
    assert.deepEqual([...new Set(platforms)], ['linkedin']);
  });
});
