import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const insightsCss = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'insights', 'insights.css'),
  'utf8',
);
const shell = readFileSync(
  path.join(PROJECT_ROOT, 'components', 'redesign', 'layout', 'app-shell-client.tsx'),
  'utf8',
);
const dashboard = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'insights', 'InsightsDashboard.tsx'),
  'utf8',
);

test('/insights styles preserve the desktop shell rail clearance (AA-145)', () => {
  // S8-5/AA-128 scoped this reset under `.insights-surface`. The guarantee this
  // test exists for — route CSS must never collapse the AppShell padding that
  // clears the fixed nav rail — is not weakened by that change but strengthened:
  // a scoped rule cannot reach the shell at all. The pattern is updated to the
  // scoped form so the check keeps biting; the assertions below are unchanged.
  const universalReset = insightsCss.match(
    /\.insights-surface \*,\s*\n\.insights-surface \*::before,\s*\n\.insights-surface \*::after\s*\{(?<declarations>[\s\S]*?)\}/,
  );

  assert.ok(universalReset?.groups?.declarations, 'expected the shared box-sizing rule');
  assert.match(universalReset.groups.declarations, /box-sizing:\s*border-box/);
  assert.doesNotMatch(
    universalReset.groups.declarations,
    /\b(?:margin|padding)\s*:/,
    'route CSS must not zero AppShell padding that clears the fixed nav rail',
  );

  // Keep the route-level guard tied to the shell contract it protects: the
  // collapsed and expanded desktop rail both reserve their full geometry.
  assert.match(shell, /lg:pl-\[104px\]/);
  assert.match(shell, /lg:peer-hover\/sidebar:pl-\[312px\]/);
});

test('/insights content padding remains usable on narrow mobile viewports (AA-145)', () => {
  assert.match(dashboard, /className="insights-dashboard-content"/);
  assert.match(
    insightsCss,
    /\.insights-dashboard-content\s*\{[^}]*padding:\s*28px 48px 72px/s,
  );
  assert.match(
    insightsCss,
    /@media\s*\(max-width:\s*640px\)\s*\{[^}]*\.insights-dashboard-content\s*\{[^}]*padding:\s*20px 16px 40px/s,
  );
});
