import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const CHECK_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'check-repo-boundary.mjs');
const siblingToken = ['mission', 'control'].join('-');

function runBoundaryCheck(codeRoot: string): string {
  return execFileSync(process.execPath, [CHECK_SCRIPT], {
    cwd: codeRoot,
    env: {
      ...process.env,
      CODE_ROOT: codeRoot,
    },
    encoding: 'utf8',
  });
}

test('repo boundary guard passes against the current repository', () => {
  const output = runBoundaryCheck(PROJECT_ROOT);
  assert.match(output, /"ok": true/);
});

test('repo boundary guard fails when a protected file mentions a sibling project', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'aries-boundary-guard-'));

  try {
    await writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'tmp', private: true }), 'utf8');
    await mkdir(path.join(tempRoot, 'app'), { recursive: true });
    await writeFile(
      path.join(tempRoot, 'app', 'page.tsx'),
      `export default function Page() { return <div>${siblingToken}</div>; }\n`,
      'utf8',
    );

    assert.throws(() => runBoundaryCheck(tempRoot), new RegExp(siblingToken, 'i'));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
