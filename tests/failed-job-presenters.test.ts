import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function presenterSource(name: string): string {
  return readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'presenters', name),
    'utf8',
  );
}

test('failed current jobs expose a clear detailed-failure action on every overview presenter', () => {
  const dashboard = presenterSource('dashboard-home-presenter.tsx');
  const calendar = presenterSource('calendar-presenter.tsx');
  const socialContent = presenterSource('post-list-presenter.tsx');

  assert.match(dashboard, /View failure details/);
  assert.match(dashboard, /model\.activePost\?\.failed\s*\?\s*'Needs Attention'\s*:\s*'Needs Approval'/);
  assert.match(dashboard, /model\.activePost\?\.failed && model\.reviews\.count > 0/);
  assert.match(dashboard, /href="\/review"/);
  assert.match(calendar, /View failure details/);
  assert.match(socialContent, /View failure details/);
});
