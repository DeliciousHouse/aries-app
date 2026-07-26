import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const workerPath = path.join(PROJECT_ROOT, 'scripts', 'automations', 'scheduled-posts-worker.mjs');

test('worker installs shutdown handlers before awaiting the initial tick', () => {
  const source = readFileSync(workerPath, 'utf8');
  const install = source.indexOf('installScheduledPostsWorkerSignalHandlers(runtime);');
  const initialTick = source.indexOf('await runtime.runTick();');
  assert.ok(install > 0 && initialTick > install);
});

test(
  'a real SIGTERM delivered during the initial tick invokes the drain handler',
  { skip: process.platform === 'win32' ? 'Windows terminates child processes instead of delivering SIGTERM to Node handlers' : false },
  async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'aries-worker-signal-'));
    const fixturePath = path.join(tempRoot, 'fixture.mjs');
    try {
      writeFileSync(
        fixturePath,
        `import { installScheduledPostsWorkerSignalHandlers } from ${JSON.stringify(pathToFileURL(workerPath).href)};
const initialTick = new Promise((resolve) => setTimeout(resolve, 250));
const runtime = {
  async shutdown() {
    console.log('DRAIN_HANDLER_CALLED');
    await initialTick;
    console.log('INITIAL_TICK_DRAINED');
    return true;
  },
};
installScheduledPostsWorkerSignalHandlers(runtime);
console.log('INITIAL_TICK_STARTED');
await initialTick;
await new Promise(() => {});
`,
      );

      const child = spawn(process.execPath, [fixturePath], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let signalSent = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (!signalSent && stdout.includes('INITIAL_TICK_STARTED')) {
          signalSent = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });

      assert.equal(signalSent, true, `fixture never started; stdout=${stdout} stderr=${stderr}`);
      assert.deepEqual(result, { code: 0, signal: null }, `stderr=${stderr}`);
      assert.match(stdout, /DRAIN_HANDLER_CALLED/);
      assert.match(stdout, /INITIAL_TICK_DRAINED/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
