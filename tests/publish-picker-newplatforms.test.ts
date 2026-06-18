/**
 * Regression coverage for the publish-target picker new-platforms expansion
 * (PR feat/publish-picker-newplatforms).
 *
 * Covers:
 *   1. RescheduleDrawer with allowedPlatforms=[fb,ig,x] renders exactly 3 platform
 *      options — the new option appears when the allowed set widens.
 *   2. RescheduleDrawer with allowedPlatforms absent renders EXACTLY 2 options (dormancy
 *      regression guard — byte-identical to today when all flags are OFF).
 *   3. RescheduleDrawer with allowedPlatforms=[fb,ig] explicit renders EXACTLY 2 options.
 *   4. CalendarPresenter prop threading: allowedPublishPlatforms flows through to
 *      RescheduleDrawer's allowedPlatforms (source-text assertion).
 *   5. calendar/page.tsx: ARIES_X_ENABLED=1 includes 'x' in allowedPublishPlatforms;
 *      unset flag excludes it; 'youtube' is never a publish target.
 *
 * Test strategy:
 *   - Source-text assertions for structural/structural-prop-threading tests (3,4,5).
 *   - Pure-function tests for flag-logic (isXEnabled / allowedPublishPlatforms logic).
 *   - jsdom component tests for the load-bearing option-count assertions (1,2,3).
 *
 * Self-contained: no DB, no real Meta API.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { installJsdom } from './helpers/jsdom-env';
import { resolveProjectRoot } from './helpers/project-root';

// DOM must exist before React and @testing-library load.
installJsdom();

import React from 'react';

/** Cast a plain string-keyed object to NodeJS.ProcessEnv without the required readonly fields. */
const mkEnv = (o: Record<string, string>): NodeJS.ProcessEnv => o as unknown as NodeJS.ProcessEnv;

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function read(...segments: string[]): string {
  return readFileSync(path.join(PROJECT_ROOT, ...segments), 'utf8');
}

// ---------------------------------------------------------------------------
// Source text: the files we assert structure over
// ---------------------------------------------------------------------------

const calendarPage = read('app', 'dashboard', 'calendar', 'page.tsx');
const calendarPresenter = read('frontend', 'aries-v1', 'presenters', 'calendar-presenter.tsx');
const calendarScreen = read('frontend', 'aries-v1', 'calendar-screen.tsx');
const rescheduleDrawer = read('frontend', 'aries-v1', 'reschedule-drawer.tsx');

// ---------------------------------------------------------------------------
// Source-text: calendar page flag wiring (test 5)
// ---------------------------------------------------------------------------

test('calendar page imports the three new platform flag functions', () => {
  assert.match(calendarPage, /isXEnabled/);
  assert.match(calendarPage, /isRedditEnabled/);
  assert.match(calendarPage, /isLinkedInEnabled/);
});

test('calendar page builds allowedPublishPlatforms spreading each flag conditionally', () => {
  assert.match(calendarPage, /allowedPublishPlatforms/);
  // Each flag guards its own spread into the array
  assert.match(calendarPage, /isXEnabled\(\)/);
  assert.match(calendarPage, /isRedditEnabled\(\)/);
  assert.match(calendarPage, /isLinkedInEnabled\(\)/);
});

test('calendar page passes allowedPublishPlatforms down to AriesCalendarScreen', () => {
  assert.match(calendarPage, /allowedPublishPlatforms={allowedPublishPlatforms}/);
});

test('calendar page never includes youtube as a publish target', () => {
  // YouTube is insights-only; it must not appear in the allowedPublishPlatforms array
  assert.doesNotMatch(calendarPage, /['"]youtube['"]/);
});

// ---------------------------------------------------------------------------
// Source-text: prop threading through screen + presenter (test 4)
// ---------------------------------------------------------------------------

test('AriesCalendarScreen accepts and threads allowedPublishPlatforms prop', () => {
  assert.match(calendarScreen, /allowedPublishPlatforms/);
  // The prop must be passed into CalendarPresenter
  assert.match(calendarScreen, /allowedPublishPlatforms={allowedPublishPlatforms}/);
});

test('CalendarPresenter declares allowedPublishPlatforms in its props interface', () => {
  assert.match(calendarPresenter, /allowedPublishPlatforms\?/);
});

test('CalendarPresenter forwards allowedPlatforms prop to RescheduleDrawer instances', () => {
  // Must appear for both the reschedule (event) and schedule (tray) drawer invocations
  const matches = calendarPresenter.match(/allowedPlatforms=\{allowedPublishPlatforms\}/g);
  assert.ok(matches && matches.length >= 2, 'allowedPlatforms must be threaded into BOTH RescheduleDrawer usages');
});

// ---------------------------------------------------------------------------
// Source-text: RescheduleDrawer structural assertions
// ---------------------------------------------------------------------------

test('RescheduleDrawer declares allowedPlatforms optional prop', () => {
  assert.match(rescheduleDrawer, /allowedPlatforms\?\s*:\s*AllowedTargetPlatform\[\]/);
});

test('RescheduleDrawer defaults allowedPlatforms to facebook+instagram when absent', () => {
  assert.match(rescheduleDrawer, /props\.allowedPlatforms\s*\?\?\s*\['facebook',\s*'instagram'\]/);
});

test('RescheduleDrawer PLATFORM_OPTIONS includes all five platforms (fb/ig/x/reddit/linkedin)', () => {
  // All five must be entries in the options table
  assert.match(rescheduleDrawer, /id:\s*'instagram'/);
  assert.match(rescheduleDrawer, /id:\s*'facebook'/);
  assert.match(rescheduleDrawer, /id:\s*'x'/);
  assert.match(rescheduleDrawer, /id:\s*'reddit'/);
  assert.match(rescheduleDrawer, /id:\s*'linkedin'/);
});

test('RescheduleDrawer renders visibleOptions filtered to the allowed set', () => {
  // The map target must be visibleOptions (the filtered list), not PLATFORM_OPTIONS
  assert.match(rescheduleDrawer, /visibleOptions\.map/);
});

// ---------------------------------------------------------------------------
// Pure-function flag tests (test 5: flag logic without React)
// ---------------------------------------------------------------------------

test('isXEnabled returns false when ARIES_X_ENABLED is unset', async () => {
  const { isXEnabled } = await import('@/backend/integrations/providers/integration-config');
  assert.equal(isXEnabled(mkEnv({})), false);
});

test('isXEnabled returns true when ARIES_X_ENABLED=1', async () => {
  const { isXEnabled } = await import('@/backend/integrations/providers/integration-config');
  assert.equal(isXEnabled(mkEnv({ ARIES_X_ENABLED: '1' })), true);
});

test('isRedditEnabled returns false when ARIES_REDDIT_ENABLED is unset', async () => {
  const { isRedditEnabled } = await import('@/backend/integrations/providers/integration-config');
  assert.equal(isRedditEnabled(mkEnv({})), false);
});

test('isLinkedInEnabled returns false when ARIES_LINKEDIN_ENABLED is unset', async () => {
  const { isLinkedInEnabled } = await import('@/backend/integrations/providers/integration-config');
  assert.equal(isLinkedInEnabled(mkEnv({})), false);
});

test('calendar page allowedPublishPlatforms logic: ARIES_X_ENABLED=1 includes x but never youtube', async () => {
  const { isXEnabled, isRedditEnabled, isLinkedInEnabled } = await import(
    '@/backend/integrations/providers/integration-config'
  );
  const env = mkEnv({ ARIES_X_ENABLED: '1' });
  const allowedPublishPlatforms: string[] = [
    'facebook',
    'instagram',
    ...(isXEnabled(env) ? ['x'] : []),
    ...(isRedditEnabled(env) ? ['reddit'] : []),
    ...(isLinkedInEnabled(env) ? ['linkedin'] : []),
  ];
  assert.ok(allowedPublishPlatforms.includes('x'), "x must be included when ARIES_X_ENABLED='1'");
  assert.ok(!allowedPublishPlatforms.includes('reddit'), 'reddit must not be included when flag off');
  assert.ok(!allowedPublishPlatforms.includes('linkedin'), 'linkedin must not be included when flag off');
  assert.ok(!allowedPublishPlatforms.includes('youtube'), 'youtube must never be a publish target');
});

test('calendar page allowedPublishPlatforms logic: all flags OFF yields facebook+instagram only', async () => {
  const { isXEnabled, isRedditEnabled, isLinkedInEnabled } = await import(
    '@/backend/integrations/providers/integration-config'
  );
  const env = mkEnv({});
  const allowedPublishPlatforms: string[] = [
    'facebook',
    'instagram',
    ...(isXEnabled(env) ? ['x'] : []),
    ...(isRedditEnabled(env) ? ['reddit'] : []),
    ...(isLinkedInEnabled(env) ? ['linkedin'] : []),
  ];
  assert.deepEqual(
    allowedPublishPlatforms,
    ['facebook', 'instagram'],
    'all flags off must produce the legacy 2-platform array',
  );
});

// ---------------------------------------------------------------------------
// jsdom component tests: RescheduleDrawer option count (tests 1,2,3)
// ---------------------------------------------------------------------------

test('RescheduleDrawer with allowedPlatforms=[fb,ig,x] renders 3 platform options', async () => {
  const { render, cleanup } = await import('@testing-library/react');
  const { default: RescheduleDrawer } = await import('../frontend/aries-v1/reschedule-drawer');

  const { container } = render(
    React.createElement(RescheduleDrawer, {
      jobId: 'test-job',
      postId: '42',
      allowedPlatforms: ['facebook', 'instagram', 'x'] as const,
      onClose: () => {},
    }),
  );

  try {
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    assert.equal(
      checkboxes.length,
      3,
      `Expected 3 platform option checkboxes, got ${checkboxes.length}`,
    );

    // Each expected option renders by testid
    assert.ok(
      container.querySelector('[data-testid="reschedule-platform-facebook"]'),
      'Facebook option must render',
    );
    assert.ok(
      container.querySelector('[data-testid="reschedule-platform-instagram"]'),
      'Instagram option must render',
    );
    assert.ok(
      container.querySelector('[data-testid="reschedule-platform-x"]'),
      'X option must render when in allowedPlatforms',
    );

    // Dormant platforms must NOT render
    assert.equal(
      container.querySelector('[data-testid="reschedule-platform-reddit"]'),
      null,
      'Reddit must not render when not in allowedPlatforms',
    );
    assert.equal(
      container.querySelector('[data-testid="reschedule-platform-linkedin"]'),
      null,
      'LinkedIn must not render when not in allowedPlatforms',
    );
  } finally {
    cleanup();
  }
});

test('RescheduleDrawer with allowedPlatforms absent renders exactly 2 options (dormancy regression guard)', async () => {
  const { render, cleanup } = await import('@testing-library/react');
  const { default: RescheduleDrawer } = await import('../frontend/aries-v1/reschedule-drawer');

  const { container } = render(
    React.createElement(RescheduleDrawer, {
      jobId: 'test-job',
      postId: '42',
      // allowedPlatforms intentionally absent — must default to facebook+instagram
      onClose: () => {},
    }),
  );

  try {
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    assert.equal(
      checkboxes.length,
      2,
      `Dormancy guard: expected exactly 2 platform checkboxes (fb+ig), got ${checkboxes.length}`,
    );
    assert.ok(
      container.querySelector('[data-testid="reschedule-platform-facebook"]'),
      'Facebook must render by default',
    );
    assert.ok(
      container.querySelector('[data-testid="reschedule-platform-instagram"]'),
      'Instagram must render by default',
    );
    assert.equal(
      container.querySelector('[data-testid="reschedule-platform-x"]'),
      null,
      'X must not render when allowedPlatforms is absent',
    );
    assert.equal(
      container.querySelector('[data-testid="reschedule-platform-reddit"]'),
      null,
      'Reddit must not render when allowedPlatforms is absent',
    );
    assert.equal(
      container.querySelector('[data-testid="reschedule-platform-linkedin"]'),
      null,
      'LinkedIn must not render when allowedPlatforms is absent',
    );
  } finally {
    cleanup();
  }
});

test('RescheduleDrawer with allowedPlatforms=[fb,ig] explicit renders exactly 2 options', async () => {
  const { render, cleanup } = await import('@testing-library/react');
  const { default: RescheduleDrawer } = await import('../frontend/aries-v1/reschedule-drawer');

  const { container } = render(
    React.createElement(RescheduleDrawer, {
      jobId: 'test-job',
      postId: '42',
      allowedPlatforms: ['facebook', 'instagram'] as const,
      onClose: () => {},
    }),
  );

  try {
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    assert.equal(
      checkboxes.length,
      2,
      `Expected exactly 2 platform checkboxes when allowedPlatforms=[fb,ig], got ${checkboxes.length}`,
    );
    assert.equal(
      container.querySelector('[data-testid="reschedule-platform-x"]'),
      null,
      'X must not render when explicitly excluded from allowedPlatforms',
    );
    assert.equal(
      container.querySelector('[data-testid="reschedule-platform-reddit"]'),
      null,
      'Reddit must not render when explicitly excluded',
    );
    assert.equal(
      container.querySelector('[data-testid="reschedule-platform-linkedin"]'),
      null,
      'LinkedIn must not render when explicitly excluded',
    );
  } finally {
    cleanup();
  }
});
