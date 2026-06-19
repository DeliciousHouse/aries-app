import assert from 'node:assert/strict';
import test from 'node:test';

import { installJsdom } from '../helpers/jsdom-env';

// DOM must exist before React / @dnd-kit load.
installJsdom();

import React from 'react';

import { createCalendarViewModel } from '../../frontend/aries-v1/view-models/calendar';
import type { ScheduledPostItem } from '../../lib/api/aries-v1';

/**
 * T1 / T14 — thin E2E smoke: the calendar planner loads and renders queued
 * posts. Deliberately light (the deterministic drag behavior is covered by
 * tests/calendar-drag.component.test.ts); this just proves the full presenter
 * tree mounts under a DOM with real data and the queued posts surface.
 */

// Derive stable current-month fixture dates so the calendar's default view
// (which opens on new Date() after the #705 fix) renders the test fixtures
// without navigating away. 14:00/16:30 UTC avoids midnight roll-overs.
const _d = new Date();
const _y = _d.getFullYear();
const _m = String(_d.getMonth() + 1).padStart(2, '0');
const FIXTURE_DAY_15_ISO = `${_y}-${_m}-15T14:00:00.000Z`;
const FIXTURE_DAY_20_ISO = `${_y}-${_m}-20T16:30:00.000Z`;

function buildScheduledPost(overrides: Partial<ScheduledPostItem> = {}): ScheduledPostItem {
  return {
    id: '901',
    postId: '42',
    jobId: 'job-1',
    tenantId: 7,
    title: 'Spring sale carousel',
    caption: 'Spring sale carousel',
    platform: 'facebook',
    targetPlatforms: ['facebook', 'instagram'],
    scheduledFor: FIXTURE_DAY_15_ISO,
    dispatchStatus: 'pending',
    dispatchedAt: null,
    errorAt: null,
    errorMessage: null,
    updatedAt: '2026-04-01T00:00:00.000Z',
    dispatches: [],
    ...overrides,
  };
}

test('calendar smoke: planner mounts and renders queued posts', async () => {
  const { render, cleanup } = await import('@testing-library/react');
  const { default: CalendarPresenter } = await import(
    '../../frontend/aries-v1/presenters/calendar-presenter'
  );

  const model = createCalendarViewModel({
    scheduledPosts: [
      buildScheduledPost({ id: '901', title: 'Spring sale carousel' }),
      buildScheduledPost({
        id: '902',
        postId: '43',
        title: 'Retargeting refresh',
        scheduledFor: FIXTURE_DAY_20_ISO,
        dispatchStatus: 'dispatched',
      }),
    ],
    posts: [],
    timeZone: 'America/New_York',
  });

  const { container } = render(
    React.createElement(CalendarPresenter, { model, onSchedule: () => {} }),
  );

  try {
    // The calendar heading mounts.
    assert.match(container.textContent ?? '', /Calendar/);
    // Both queued posts render as tiles.
    assert.ok(container.querySelector('[data-testid="tile-901"]'), 'first queued post renders');
    assert.ok(container.querySelector('[data-testid="tile-902"]'), 'second queued post renders');
    // The "queued posts" counter reflects the real queue size.
    assert.match(container.textContent ?? '', /2 queued posts/);
  } finally {
    cleanup();
  }
});

test('calendar smoke: empty queue renders the planner without crashing', async () => {
  const { render, cleanup } = await import('@testing-library/react');
  const { default: CalendarPresenter } = await import(
    '../../frontend/aries-v1/presenters/calendar-presenter'
  );

  const model = createCalendarViewModel({
    scheduledPosts: [],
    posts: [],
    timeZone: 'America/New_York',
  });

  const { container } = render(
    React.createElement(CalendarPresenter, { model, onSchedule: () => {} }),
  );

  try {
    assert.match(container.textContent ?? '', /Calendar/);
    assert.equal(container.querySelectorAll('[data-testid^="tile-"]').length, 0);
    // The grid still renders its day-cell skeleton when the queue is empty.
    assert.ok(container.querySelectorAll('[data-testid^="cell-"]').length >= 28);
  } finally {
    cleanup();
  }
});
