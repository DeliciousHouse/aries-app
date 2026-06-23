/**
 * Regression test for #705 — calendar-presenter initial visible month.
 *
 * BUG: useState(() => getInitialCalendarDate(model.events, timeZone)) anchored
 * the initial month to the earliest queued event. When all events are in the
 * past (e.g. April/May while today is June), the calendar opened on the past
 * month instead of the current one.
 *
 * FIX: useState(() => new Date()) — the calendar always opens on today.
 *
 * FAIL-BEFORE: getInitialCalendarDate with all-past events returns the
 * earliest event date (April 2026). The heading renders "April 2026".
 * expectedMonthLabel is "June 2026". assert.ok(monthHeading) fails.
 *
 * PASS-AFTER: new Date() produces the current month. The heading matches
 * expectedMonthLabel.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { installJsdom } from './helpers/jsdom-env';

// DOM must exist before React / @dnd-kit / @testing-library load.
installJsdom();

import React from 'react';

import { createCalendarViewModel } from '../frontend/aries-v1/view-models/calendar';
import type { ScheduledPostItem } from '../lib/api/aries-v1';

// Compute the expected heading label once from the wall-clock "today". The
// presenter's useState(() => new Date()) runs at render time in the same
// test invocation — both will always be in the same month.
const expectedMonthLabel = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
}).format(new Date());

function buildPastScheduledPost(
  overrides: Partial<ScheduledPostItem> = {},
): ScheduledPostItem {
  return {
    id: '801',
    postId: '11',
    jobId: 'job-past-1',
    tenantId: 7,
    title: 'Old dispatched post',
    caption: 'Old dispatched post',
    platform: 'facebook',
    targetPlatforms: ['facebook'],
    // April 10 2026 — well in the past relative to the June 2026 fix date.
    scheduledFor: '2026-04-10T12:00:00.000Z',
    dispatchStatus: 'dispatched',
    dispatchedAt: '2026-04-10T12:05:00.000Z',
    errorAt: null,
    errorMessage: null,
    updatedAt: '2026-04-10T00:00:00.000Z',
    dispatches: [],
    ...overrides,
  };
}

test(
  'CalendarPresenter opens on the current month when all events are in the past',
  async () => {
    const { render, cleanup } = await import('@testing-library/react');
    const { default: CalendarPresenter } = await import(
      '../frontend/aries-v1/presenters/calendar-presenter'
    );

    // Two events, both in April 2026 (past). Pre-fix: getInitialCalendarDate
    // returns the April event → heading shows "April 2026". Post-fix: new Date()
    // → heading shows the current month.
    const model = createCalendarViewModel({
      scheduledPosts: [
        buildPastScheduledPost({
          id: '801',
          postId: '11',
          scheduledFor: '2026-04-10T12:00:00.000Z',
        }),
        buildPastScheduledPost({
          id: '802',
          postId: '12',
          scheduledFor: '2026-04-20T14:00:00.000Z',
        }),
      ],
      posts: [],
      timeZone: 'America/New_York',
    });

    const { container } = render(
      React.createElement(CalendarPresenter, { model }),
    );

    try {
      // The calendar renders several h2 elements:
      //   "Calendar" (static title)
      //   "<Month> <Year>" (the live initial-month heading we care about)
      //   "Social content status at a glance" (static)
      //   "Backlog" (unscheduled tray)
      // Only the month heading will exactly match expectedMonthLabel.
      const headings = Array.from(container.querySelectorAll('h2'));
      const monthHeading = headings.find(
        (h) => h.textContent?.trim() === expectedMonthLabel,
      );

      assert.ok(
        monthHeading,
        `Calendar should open on the current month ("${expectedMonthLabel}") but none of the h2 headings matched. ` +
          `Rendered headings: ${headings.map((h) => JSON.stringify(h.textContent?.trim())).join(', ')}. ` +
          `This means the calendar anchored to an event month rather than today (pre-fix regression).`,
      );
    } finally {
      cleanup();
    }
  },
);
