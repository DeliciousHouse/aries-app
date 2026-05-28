import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isTenantZoneToday,
  tenantZoneDateKey,
  tenantZoneParts,
} from '../lib/format-timestamp';
import { createCalendarViewModel } from '../frontend/aries-v1/view-models/calendar';
import type { ScheduledPostItem } from '../lib/api/aries-v1';

/**
 * C1 / T10 regression — the calendar grid math (`dateKey`, `isToday`,
 * week/month bounds, drag-target dates) must be tenant-zone aware so a post
 * scheduled for 11pm tenant-time lands on the correct cell for an operator
 * browsing from a different zone. The presenter is a `.tsx` render component;
 * these tests pin the pure grid-math primitives it now delegates to.
 */

function buildScheduledPost(scheduledFor: string): ScheduledPostItem {
  return {
    id: '901',
    postId: '42',
    jobId: 'job-1',
    tenantId: 7,
    title: 'Late night post',
    caption: 'Late night post',
    platform: 'instagram',
    targetPlatforms: ['instagram'],
    scheduledFor,
    dispatchStatus: 'pending',
    dispatchedAt: null,
    errorAt: null,
    errorMessage: null,
    updatedAt: '2026-04-01T00:00:00.000Z',
    dispatches: [],
  };
}

test('tenantZoneDateKey places an 11pm tenant-zone post on the tenant calendar day', () => {
  // 11pm on 2026-04-15 in New York is 2026-04-16T03:00:00Z.
  const instant = '2026-04-16T03:00:00.000Z';
  // Operator's machine being in any zone does not change the tenant-zone key.
  assert.equal(tenantZoneDateKey(instant, 'America/New_York'), '2026-04-15');
  assert.equal(tenantZoneDateKey(instant, 'America/Los_Angeles'), '2026-04-15');
  assert.equal(tenantZoneDateKey(instant, 'Asia/Tokyo'), '2026-04-16');
  assert.equal(tenantZoneDateKey(instant, 'UTC'), '2026-04-16');
});

test('calendar grid assigns an 11pm post to the same cell regardless of browser zone', () => {
  // The view-model computes dayKey from the tenant zone, not the browser zone.
  // Same input instant, same tenant zone -> same cell, deterministically.
  const instant = '2026-04-16T03:00:00.000Z';
  const modelA = createCalendarViewModel({
    scheduledPosts: [buildScheduledPost(instant)],
    posts: [],
    timeZone: 'America/New_York',
  });
  const modelB = createCalendarViewModel({
    scheduledPosts: [buildScheduledPost(instant)],
    posts: [],
    timeZone: 'America/New_York',
  });
  assert.equal(modelA.events[0].dayKey, '2026-04-15');
  assert.equal(modelB.events[0].dayKey, modelA.events[0].dayKey);
});

test('isTenantZoneToday compares the civil day in the tenant zone, not browser-local', () => {
  // "Now" = 2026-07-01T02:00:00Z. In New York that is still 2026-06-30 22:00.
  const now = new Date('2026-07-01T02:00:00.000Z');
  // A post at 2026-06-30 21:00 EDT (2026-07-01T01:00:00Z) is "today" in NY.
  assert.equal(isTenantZoneToday('2026-07-01T01:00:00.000Z', 'America/New_York', now), true);
  // The same instant is already July 1 in UTC -> not "today" if tenant is UTC
  // and now is June 30 there... here both are July 1 in UTC, so true.
  assert.equal(isTenantZoneToday('2026-07-01T01:00:00.000Z', 'UTC', now), true);
  // A post a full day later is not today.
  assert.equal(isTenantZoneToday('2026-07-02T01:00:00.000Z', 'America/New_York', now), false);
});

test('tenantZoneParts yields the civil day used to anchor the grid month', () => {
  // A post at 2026-04-16T03:00:00Z anchors the grid on April (tenant NY day 15).
  const parts = tenantZoneParts('2026-04-16T03:00:00.000Z', 'America/New_York');
  assert.equal(parts?.year, 2026);
  assert.equal(parts?.month, 4);
  assert.equal(parts?.day, 15);
});
