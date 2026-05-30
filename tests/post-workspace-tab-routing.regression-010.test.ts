import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  resolveWorkspaceView,
  type WorkspaceView,
} from '../frontend/aries-v1/post-workspace-state';

// Regression coverage for ISSUE-010 — clicking Brand / Strategy / Creative /
// Launch Status tabs changed the URL ?view= param but the rendered content
// did not update. Root cause: the client component derived `activeView` from
// a server-component prop (`initialView`), so SPA navigation — which only
// mutates search params without re-running the server component — never
// reached the tab switch. Fix reads the view via next/navigation
// useSearchParams() and funnels it through resolveWorkspaceView().

test('resolveWorkspaceView accepts every valid WorkspaceView value', () => {
  const cases: Array<WorkspaceView> = ['brand', 'strategy', 'creative', 'publish'];
  for (const view of cases) {
    assert.equal(resolveWorkspaceView(view), view);
  }
});

test('resolveWorkspaceView falls back to brand by default for null / unknown input', () => {
  assert.equal(resolveWorkspaceView(null), 'brand');
  assert.equal(resolveWorkspaceView(undefined), 'brand');
  assert.equal(resolveWorkspaceView(''), 'brand');
  assert.equal(resolveWorkspaceView('overview'), 'brand');
  assert.equal(resolveWorkspaceView('BRAND'), 'brand'); // strict match, case-sensitive
});

test('resolveWorkspaceView honours an explicit fallback when the value is absent', () => {
  assert.equal(resolveWorkspaceView(null, 'creative'), 'creative');
  assert.equal(resolveWorkspaceView(undefined, 'publish'), 'publish');
  // Valid value overrides the fallback.
  assert.equal(resolveWorkspaceView('strategy', 'creative'), 'strategy');
});

// Source-level guard: the campaign workspace client must read the view from
// the live URL (useSearchParams) rather than a frozen server prop. This stops
// the original bug from regressing even if a future refactor reintroduces
// the prop-only pattern.
test('post-workspace client wires the view through useSearchParams', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    resolve(here, '..', 'frontend', 'aries-v1', 'post-workspace.tsx'),
    'utf8',
  );
  assert.match(
    source,
    /from ['"]next\/navigation['"]/,
    'post-workspace.tsx must import from next/navigation',
  );
  assert.match(
    source,
    /useSearchParams\s*\(\s*\)/,
    'post-workspace.tsx must call useSearchParams() so URL ?view= changes drive rendering',
  );
  assert.match(
    source,
    /resolveWorkspaceView\(/,
    'post-workspace.tsx must funnel the view through resolveWorkspaceView for validation',
  );
  assert.match(
    source,
    /<Link[\s\S]*?href=\{currentStageHref\(props\.postId, view\)\}[\s\S]*?scroll=\{false\}/,
    'post-workspace.tsx must disable Next Link scroll resets for view-pill navigation',
  );
});
