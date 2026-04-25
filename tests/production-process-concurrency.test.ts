import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as JsonRecord;
}

test('production runtime uses native Node cluster workers by default', () => {
  const startRuntime = readFileSync(path.join(PROJECT_ROOT, 'scripts/start-runtime.mjs'), 'utf8');

  assert.match(startRuntime, /from 'node:cluster'/, 'start-runtime should use the built-in cluster module');
  assert.match(startRuntime, /defaultWebConcurrency = 2/, 'default worker count should be at least two');
  assert.match(startRuntime, /cluster\.setupPrimary\(\{[\s\S]*exec: nextCliPath\(\),[\s\S]*args: \['start', '-p', String\(parsedPort\)\]/);
  assert.match(startRuntime, /cluster\.fork\(\{[\s\S]*APP_INSTANCE_ID: String\(instanceId\)/, 'each worker should get an APP_INSTANCE_ID');
  assert.match(startRuntime, /ARIES_WEB_CONCURRENCY/, 'worker count should be tunable without rebuilding the image');
  assert.match(startRuntime, /WEB_CONCURRENCY/, 'generic WEB_CONCURRENCY should be accepted outside Compose');
  assert.match(startRuntime, /ARIES_PROCESS_MANAGER/, 'runtime should expose a process-manager rollback knob');
  assert.match(startRuntime, /normalized === 'node'/, 'runtime should keep a single-process rollback mode');
  assert.match(startRuntime, /spawn\(process\.execPath/, 'single-process rollback should run next directly through node');
});

test('package and Dockerfile avoid a PM2 production dependency', () => {
  const packageJson = asRecord(
    JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')),
    'package.json',
  );
  const scripts = asRecord(packageJson.scripts, 'package.json scripts');
  const dependencies = asRecord(packageJson.dependencies, 'package.json dependencies');

  assert.equal(scripts.start, 'node scripts/start-runtime.mjs');
  assert.equal(dependencies.pm2, undefined, 'native cluster mode should avoid adding PM2 as a production dependency');
  assert.equal(existsSync(path.join(PROJECT_ROOT, 'ecosystem.config.cjs')), false, 'PM2 ecosystem config should not be required');

  const dockerfile = readFileSync(path.join(PROJECT_ROOT, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /ecosystem\.config\.cjs/, 'runtime image should not depend on a PM2 config file');
  assert.match(dockerfile, /CMD \["npm", "run", "start"\]/, 'runtime image should enter through the concurrency-aware start script');
});

test('compose config exposes worker and pool knobs while preserving one upstream port', () => {
  const baseCompose = readFileSync(path.join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8');
  const baseAriesApp = baseCompose.match(/services:\n  aries-app:\n[\s\S]*?(?=\nnetworks:|\nvolumes:|$)/);
  assert.ok(baseAriesApp, 'expected to find the base aries-app service definition');

  assert.match(
    baseAriesApp![0],
    /ARIES_PROCESS_MANAGER: \$\{ARIES_PROCESS_MANAGER:-cluster\}/,
    'production compose should default to native cluster process management',
  );
  assert.match(
    baseAriesApp![0],
    /ARIES_WEB_CONCURRENCY: \$\{ARIES_WEB_CONCURRENCY:-2\}/,
    'production compose should default to at least two web workers',
  );
  assert.match(
    baseAriesApp![0],
    /DB_POOL_MAX: \$\{DB_POOL_MAX:-20\}/,
    'production compose should make the per-worker pg pool size explicit',
  );
  assert.match(
    baseAriesApp![0],
    /ports:\n\s+- "\$\{PORT:-3000\}:\$\{PORT:-3000\}"/,
    'the external reverse proxy should keep using the single published upstream port',
  );
});

test('Docker operations docs avoid committing live benchmark identifiers', () => {
  const dockerDocs = readFileSync(path.join(PROJECT_ROOT, 'DOCKER.md'), 'utf8');

  assert.match(dockerDocs, /ARIES_PROCESS_MANAGER=cluster/);
  assert.match(dockerDocs, /ARIES_WEB_CONCURRENCY=4 DB_POOL_MAX=10/);
  assert.match(dockerDocs, /BASE_URL="https:\/\/<aries-host>"/);
  assert.match(dockerDocs, /JOB_ID="<campaign-job-id>"/);
  assert.doesNotMatch(dockerDocs, /aries\.sugarandleather\.com/);
  assert.doesNotMatch(dockerDocs, /mkt_[0-9a-f-]{36}/);
});
