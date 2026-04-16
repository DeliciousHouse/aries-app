import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function runNodeScript(scriptPath: string, env: Record<string, string | undefined> = {}) {
  return spawnSync('node', [path.join(PROJECT_ROOT, scriptPath)], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('workspace verify falls back to the live git root when /app/aries-app is absent', () => {
  const result = runNodeScript('scripts/verify-canonical-workspace.mjs');

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.gitRoot, PROJECT_ROOT);
  assert.equal(payload.canonicalRoot, PROJECT_ROOT);
});

test('runtime precheck ignores an invalid CODE_ROOT and uses the real repo root', () => {
  const result = runNodeScript('scripts/runtime-precheck.mjs', { CODE_ROOT: '/app' });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
});
