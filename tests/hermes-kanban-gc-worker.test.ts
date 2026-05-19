import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const WORKER_PATH = path.join(PROJECT_ROOT, 'scripts', 'hermes-kanban-gc-worker.ts');
const TSX_PATH = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

test('hermes kanban gc worker archives only done tasks older than retention, then runs gc once', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'aries-kanban-gc-'));
  const logPath = path.join(tempDir, 'calls.log');
  const hermesPath = path.join(tempDir, 'hermes');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oldCompletedAt = nowSeconds - 9 * 24 * 60 * 60;
  const recentCompletedAt = nowSeconds - 2 * 24 * 60 * 60;

  writeFileSync(
    hermesPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
if (args.join(' ') === 'kanban list --status done --json') {
  process.stdout.write(JSON.stringify([
    { id: 't_old', status: 'done', completed_at: ${oldCompletedAt} },
    { id: 't_recent', status: 'done', completed_at: ${recentCompletedAt} },
    { id: 't_null', status: 'done', completed_at: null },
    { id: 't_archived', status: 'archived', completed_at: ${oldCompletedAt} }
  ]));
  process.exit(0);
}
if (args[0] === 'kanban' && args[1] === 'archive') {
  process.exit(args.length === 3 && args[2] === 't_old' ? 0 : 2);
}
if (args.join(' ') === 'kanban gc') {
  process.stdout.write('GC complete: 3 workspace(s), 0 event row(s), 0 log file(s) removed');
  process.exit(0);
}
process.exit(3);
`,
  );
  chmodSync(hermesPath, 0o755);

  const result = spawnSync(process.execPath, [TSX_PATH, WORKER_PATH], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ARIES_KANBAN_GC_ENABLED: '1',
      ARIES_KANBAN_GC_RETENTION_DAYS: '7',
      ARIES_KANBAN_GC_INTERVAL_MS: '1000000',
      ARIES_KANBAN_GC_RUN_ONCE: '1',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /\[hermes-kanban-gc\] starting; interval=1000000ms retention_days=7/);
  assert.match(result.stdout, /\[hermes-kanban-gc\] summary \{"archived":1,"workspaces_removed":3,"errors":0\}/);
  assert.deepEqual(
    readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [
      ['kanban', 'list', '--status', 'done', '--json'],
      ['kanban', 'archive', 't_old'],
      ['kanban', 'gc'],
    ],
  );
});

test('runtime supervisor wires the hermes kanban gc worker side-process', () => {
  const startRuntime = readFileSync(path.join(PROJECT_ROOT, 'scripts/start-runtime.mjs'), 'utf8');
  const compose = readFileSync(path.join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8');

  assert.match(startRuntime, /hermes-kanban-gc-worker\.ts/);
  assert.match(startRuntime, /spawnHermesKanbanGcWorker\(\)/);
  assert.match(startRuntime, /stopHermesKanbanGcWorker\(\)/);
  assert.match(startRuntime, /ARIES_KANBAN_GC_ENABLED/);
  assert.match(compose, /ARIES_KANBAN_GC_INTERVAL_MS: \$\{ARIES_KANBAN_GC_INTERVAL_MS:-86400000\}/);
  assert.match(compose, /ARIES_KANBAN_GC_RETENTION_DAYS: \$\{ARIES_KANBAN_GC_RETENTION_DAYS:-7\}/);
});
