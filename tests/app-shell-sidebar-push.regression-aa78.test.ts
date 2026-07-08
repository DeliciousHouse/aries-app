import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

// AA-78: the desktop rail is position:fixed and expands 72px -> 280px on hover
// (or while a rail menu pins it open). It used to OVERLAY the page content,
// clipping the left edge of every heading/card. The contract under test: an
// expanded rail PUSHES the content aside — <main> left padding grows in sync —
// instead of sliding over it.

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const shell = readFileSync(
  path.join(PROJECT_ROOT, 'components', 'redesign', 'layout', 'app-shell-client.tsx'),
  'utf8',
);

test('rail aside is a named peer so <main> can react to its hover (AA-78)', () => {
  // group/sidebar drives the rail's own internals; peer/sidebar is what lets a
  // SIBLING (<main>) restyle on rail hover. Both must be on the same aside.
  assert.match(shell, /group\/sidebar peer\/sidebar/);
});

test('main pushes aside on rail hover instead of being overlaid (AA-78)', () => {
  // Collapsed baseline: 16px edge + 72px rail + 16px gap.
  assert.match(shell, /lg:pl-\[104px\]/);
  // Hover-expanded: 16px edge + 280px rail + 16px gap — driven by the peer.
  assert.match(shell, /lg:peer-hover\/sidebar:pl-\[312px\]/);
});

test('pinned-expanded rail (menu open) also pushes main (AA-78)', () => {
  // keepSidebarExpanded pins the rail at 280px; main must take the pushed
  // padding unconditionally in that branch, not depend on hover.
  assert.match(shell, /keepSidebarExpanded\s*\n?\s*\?\s*'lg:pl-\[312px\]'/);
});

test('push geometry and timing mirror the rail itself (AA-78)', () => {
  // 104 = left-4 (16) + collapsed w-[72px] + 16 gap; 312 = 16 + expanded
  // w-[280px] + 16. Pin BOTH rail widths (collapsed, and the hover-expansion
  // token specifically) so any rail resize forces this math to be revisited —
  // the pinned-expanded w-[280px] alone would mask a hover:w change.
  assert.match(shell, /w-\[72px\] hover:w-\[280px\]/);
  assert.match(shell, /left-4 top-4 bottom-4/);
  // The padding transition must match the rail width transition (420ms, same
  // easing) so rail and content move as one surface, not two.
  assert.match(shell, /transition-\[width\] duration-\[420ms\]/);
  assert.match(shell, /lg:transition-\[padding-left\] lg:duration-\[420ms\]/);
});

test('rail-pinning menus close on click, never mousedown (AA-78 follow-up)', () => {
  // Closing the account menu or the workspace switcher un-pins the rail
  // (keepSidebarExpanded) and slides <main> 312->104px. A mousedown-close
  // starts that slide BEFORE mouseup, so the click the user aimed at content
  // straddles a moving target and never fires. Both outside-close listeners
  // must therefore be 'click' (fires after the aimed click completes).
  const switcher = readFileSync(
    path.join(PROJECT_ROOT, 'components', 'redesign', 'layout', 'workspace-switcher.tsx'),
    'utf8',
  );
  assert.match(shell, /document\.addEventListener\('click', handleClickOutside\)/);
  assert.match(switcher, /document\.addEventListener\('click', onOutsideClick\)/);
  assert.doesNotMatch(shell, /addEventListener\('mousedown'/);
  assert.doesNotMatch(switcher, /addEventListener\('mousedown'/);
});

test('hover-intent delay is mirrored on rail and main (AA-78)', () => {
  // 150ms expansion delay: an incidental pointer graze over the rail moves
  // nothing. The delay must exist on BOTH the rail width (hover:) and the main
  // padding (peer-hover/sidebar:) or the two surfaces desync for 150ms.
  assert.match(shell, /hover:w-\[280px\] hover:delay-150/);
  assert.match(shell, /lg:peer-hover\/sidebar:pl-\[312px\] lg:peer-hover\/sidebar:delay-150/);
  // Reduced-motion users get the pushed layout without the 208px slide.
  assert.match(shell, /lg:motion-reduce:transition-none/);
});
