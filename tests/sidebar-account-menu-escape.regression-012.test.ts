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

// ISSUE-A11Y-ACCOUNT-MENU-ESC — the desktop account/avatar menu closed on
// click-outside but did not respond to Escape, trapping an open popover until a
// pointer interaction happened.

test('desktop sidebar account menu keeps click-outside close behavior', () => {
  assert.match(
    appShellSource,
    /if \(accountMenuRef\.current && !accountMenuRef\.current\.contains\(event\.target as Node\)\) \{\s*setIsAccountMenuOpen\(false\);\s*\}/,
    'account menu should still close when a click lands outside accountMenuRef',
  );
  // 'click', NOT 'mousedown': closing un-pins the rail and slides the content,
  // so a mousedown-close starts the slide before mouseup and swallows the click
  // the user aimed at content (AA-78 follow-up).
  assert.match(appShellSource, /document\.addEventListener\('click', handleClickOutside\);/);
  assert.match(appShellSource, /document\.removeEventListener\('click', handleClickOutside\);/);
});

test('desktop sidebar account menu closes on Escape via a document keydown handler', () => {
  assert.match(
    appShellSource,
    /function handleKeyDown\(event: KeyboardEvent\) \{\s*if \(event\.key === 'Escape'\) \{\s*setIsAccountMenuOpen\(false\);\s*\}\s*\}/,
    'Escape should dismiss the desktop account menu',
  );
  assert.match(appShellSource, /document\.addEventListener\('keydown', handleKeyDown\);/);
  assert.match(appShellSource, /document\.removeEventListener\('keydown', handleKeyDown\);/);
});
