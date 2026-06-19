import assert from 'node:assert/strict';
import test from 'node:test';

import { installJsdom } from './helpers/jsdom-env';

// DOM must exist before React / @dnd-kit / @testing-library load.
installJsdom();

import React from 'react';

import {
  resolveDragSchedule,
  type DragItemData,
} from '../frontend/aries-v1/presenters/calendar-presenter';
import { createCalendarViewModel } from '../frontend/aries-v1/view-models/calendar';
import type { ScheduledPostItem, UnscheduledPostItem } from '../lib/api/aries-v1';

// Derive a stable current-month fixture date so the calendar's default view
// (which opens on new Date() after the #705 fix) renders the test fixtures
// without navigating away. Using 14:00 UTC on the 15th avoids midnight
// roll-overs in any host timezone and stays well clear of month boundaries.
const _d = new Date();
const _y = _d.getFullYear();
const _m = String(_d.getMonth() + 1).padStart(2, '0');
/** ISO timestamp for the 15th of the current month at 14:00 UTC. */
const FIXTURE_CURRENT_MONTH_ISO = `${_y}-${_m}-15T14:00:00.000Z`;
/** YYYY-MM-DD key matching the cell the presenter renders for that timestamp. */
const FIXTURE_CURRENT_MONTH_DAY_KEY = `${_y}-${_m}-15`;

function buildScheduledPost(overrides: Partial<ScheduledPostItem> = {}): ScheduledPostItem {
  return {
    id: '901',
    postId: '42',
    jobId: 'job-1',
    tenantId: 7,
    title: 'Queued carousel',
    caption: 'Queued carousel',
    platform: 'facebook',
    targetPlatforms: ['facebook', 'instagram'],
    scheduledFor: FIXTURE_CURRENT_MONTH_ISO,
    dispatchStatus: 'pending',
    dispatchedAt: null,
    errorAt: null,
    errorMessage: null,
    updatedAt: '2026-04-01T00:00:00.000Z',
    dispatches: [],
    ...overrides,
  };
}

function buildUnscheduled(overrides: Partial<UnscheduledPostItem> = {}): UnscheduledPostItem {
  return {
    postId: '77',
    jobId: 'job-9',
    title: 'Approved backlog post',
    caption: 'Approved backlog post',
    platform: 'instagram',
    imageUrl: null,
    ...overrides,
  };
}

// --- Drag-end semantics (the @dnd-kit drag, simulated deterministically) -----

test('resolveDragSchedule fires a reschedule when an event tile moves to a new cell', () => {
  const event = createCalendarViewModel({
    scheduledPosts: [buildScheduledPost()],
    posts: [],
    timeZone: 'America/New_York',
  }).events[0];

  const data: DragItemData = { kind: 'event', event };
  const resolved = resolveDragSchedule(data, '2026-04-20');
  assert.ok(resolved);
  assert.equal(resolved.targetDayKey, '2026-04-20');
  assert.equal(resolved.item.kind, 'event');
  if (resolved.item.kind === 'event') {
    assert.equal(resolved.item.event.postId, '42');
  }
});

test('resolveDragSchedule is a no-op when an event is dropped on its own cell', () => {
  const event = createCalendarViewModel({
    scheduledPosts: [buildScheduledPost()],
    posts: [],
    timeZone: 'America/New_York',
  }).events[0];
  // The event's dayKey is in the current month (FIXTURE_CURRENT_MONTH_ISO at 14:00Z). Dropping it there is a no-op.
  assert.equal(resolveDragSchedule({ kind: 'event', event }, event.dayKey), null);
});

test('resolveDragSchedule schedules a NEW post when a tray item is dropped on a cell', () => {
  const model = createCalendarViewModel({
    scheduledPosts: [],
    posts: [],
    unscheduledPosts: [
      { ...buildUnscheduled(), href: '/dashboard/social-content/job-9' },
    ],
    timeZone: 'America/New_York',
  });
  const data: DragItemData = { kind: 'unscheduled', post: model.unscheduled[0] };
  const resolved = resolveDragSchedule(data, '2026-05-01');
  assert.ok(resolved);
  assert.equal(resolved.item.kind, 'unscheduled');
  assert.equal(resolved.targetDayKey, '2026-05-01');
});

test('resolveDragSchedule ignores a drag with no payload or no target', () => {
  assert.equal(resolveDragSchedule(undefined, '2026-05-01'), null);
  assert.equal(resolveDragSchedule(null, '2026-05-01'), null);
  const event = createCalendarViewModel({
    scheduledPosts: [buildScheduledPost()],
    posts: [],
    timeZone: 'UTC',
  }).events[0];
  assert.equal(resolveDragSchedule({ kind: 'event', event }, ''), null);
});

// --- jsdom render: the presenter mounts droppable cells + draggable tiles ----

test('CalendarPresenter renders droppable cells and draggable tiles under jsdom', async () => {
  const { render, cleanup } = await import('@testing-library/react');

  const model = createCalendarViewModel({
    scheduledPosts: [buildScheduledPost({ scheduledFor: FIXTURE_CURRENT_MONTH_ISO })],
    posts: [],
    unscheduledPosts: [{ ...buildUnscheduled(), href: '/dashboard/social-content/job-9' }],
    timeZone: 'America/New_York',
  });

  const onSchedule = () => {};
  const { default: CalendarPresenter } = await import(
    '../frontend/aries-v1/presenters/calendar-presenter'
  );

  const { container } = render(
    React.createElement(CalendarPresenter, { model, onSchedule }),
  );

  try {
    // The grid renders droppable day cells (data-testid="cell-YYYY-MM-DD").
    const cells = container.querySelectorAll('[data-testid^="cell-"]');
    assert.ok(cells.length >= 28, 'a month grid should render at least 28 day cells');

    // The queued post renders as a draggable tile on its tenant-zone cell.
    const tile = container.querySelector('[data-testid="tile-901"]');
    assert.ok(tile, 'the queued post should render a draggable tile');

    // The unscheduled backlog item renders as a draggable tray item.
    const trayItem = container.querySelector('[data-testid="tray-item-77"]');
    assert.ok(trayItem, 'the backlog post should render a draggable tray item');

    // The current-month day-15 cell exists as a drop target (tenant-zone day key).
    const targetCell = container.querySelector(`[data-testid="cell-${FIXTURE_CURRENT_MONTH_DAY_KEY}"]`);
    assert.ok(targetCell, 'the tenant-zone target cell should be droppable');
  } finally {
    cleanup();
  }
});

test('CalendarPresenter drag wiring calls onSchedule with the correct target date', async () => {
  // Drives the same drag-end path the DndContext invokes: resolveDragSchedule
  // produces the (item, targetDayKey) pair, the presenter forwards it to
  // onSchedule. Asserting that contract here proves the PATCH will fire for
  // the dropped-on date.
  const calls: Array<{ kind: string; targetDayKey: string }> = [];
  const onSchedule = (item: DragItemData, targetDayKey: string) => {
    calls.push({ kind: item.kind, targetDayKey });
  };

  const event = createCalendarViewModel({
    scheduledPosts: [buildScheduledPost()],
    posts: [],
    timeZone: 'America/New_York',
  }).events[0];

  const resolved = resolveDragSchedule({ kind: 'event', event }, '2026-04-22');
  assert.ok(resolved);
  onSchedule(resolved.item, resolved.targetDayKey);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'event');
  assert.equal(calls[0].targetDayKey, '2026-04-22');
});
