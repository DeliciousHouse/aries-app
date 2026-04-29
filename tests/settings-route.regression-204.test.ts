import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const source = readFileSync(
  path.join(PROJECT_ROOT, 'app', 'dashboard', 'settings', 'page.tsx'),
  'utf8',
);

test('settings route renders AppShellLayout with currentRouteId="settings"', () => {
  assert.match(
    source,
    /AppShellLayout/,
    'page.tsx must import and render AppShellLayout',
  );
  assert.match(
    source,
    /currentRouteId=["']settings["']/,
    'AppShellLayout must receive currentRouteId="settings"',
  );
});

test('settings route renders AriesSettingsScreen', () => {
  assert.match(
    source,
    /AriesSettingsScreen/,
    'page.tsx must import and render AriesSettingsScreen',
  );
});

test('settings route does not redirect away from /dashboard/settings', () => {
  assert.doesNotMatch(
    source,
    /redirect\s*\(/,
    'page.tsx must NOT call redirect() — the My Account / Settings screen must be reachable',
  );
});
