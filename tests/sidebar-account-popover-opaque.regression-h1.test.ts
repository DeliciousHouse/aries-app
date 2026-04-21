import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const appShellSource = readFileSync(
  path.join(PROJECT_ROOT, 'components', 'redesign', 'layout', 'app-shell-client.tsx'),
  'utf8',
);

// ISSUE-W2-H1 — Sidebar account-menu popover was translucent (bg-white/[0.06]
// + backdrop-blur-xl). Because the sidebar itself is 280px wide and the
// popover is also 280px wide pinned bottom-14/left-0, the popover entries
// (Business profile, Channel integrations, Review queue, Logout) visually
// overlapped the nav rail items (Posts, Calendar, Results) underneath.
// Fix: give the popover an opaque base background so nav items can't bleed
// through.
test('sidebar account popover has an opaque background (not bg-white/[0.06])', () => {
  const popoverClassMatch = appShellSource.match(
    /id="sidebar-account-menu"[\s\S]*?className="([^"]+)"/,
  );
  assert.ok(popoverClassMatch, 'expected to find sidebar-account-menu popover className');
  const classes = popoverClassMatch![1];

  assert.ok(
    /\bbg-neutral-950\b/.test(classes) || /\bbg-black\b/.test(classes),
    `expected popover to include an opaque bg token (bg-neutral-950 or bg-black); got: ${classes}`,
  );
  assert.ok(
    !/bg-white\/\[0\.06\]/.test(classes),
    'popover must not use bg-white/[0.06] as its only background — nav items bleed through',
  );
});
